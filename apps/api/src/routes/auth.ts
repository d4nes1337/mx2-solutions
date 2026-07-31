import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  ChallengeStore,
  UserStore,
  SessionStore,
  AllowlistStore,
  AuditStore,
  InvitationStore,
  NotificationChannelStore,
  ReferralStore,
  SignLinkTokenStore,
  WaitlistStore,
} from "@mx2/db";
import type { AppConfig } from "@mx2/config";
import {
  createLoginChallenge,
  verifyLoginSignature,
  recoverLoginAddress,
  recoverFromRawTypedData,
  CHALLENGE_TTL_MS,
} from "../auth/eip712.js";
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from "../auth/session.js";
import { UNAUTHORIZED_BODY } from "../auth/unauthorized.js";
import { hashInviteCode } from "../auth/invite-code.js";
import { verifyTelegramInitData } from "../auth/telegram-miniapp.js";
import { deriveDepositWallet } from "@mx2/polymarket-client";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeRateLimit } from "../middleware/rate-limit.js";
import type {} from "../auth/types.js";

export interface AuthRoutesDeps {
  config: AppConfig;
  challenges: ChallengeStore;
  users: UserStore;
  sessions: SessionStore;
  allowlist: AllowlistStore;
  auditStore: AuditStore;
  /** Sign-link tokens (FEATURE_NOTIFICATIONS); the exchange route needs it. */
  signTokens?: SignLinkTokenStore;
  /** Channel links (FEATURE_TELEGRAM_MINIAPP); the Mini App login needs it. */
  notificationChannels?: NotificationChannelStore;
  /** Private-beta invitations; verify accepts an inviteCode when present. */
  invitations?: InvitationStore;
  /** Waitlist queue; a redeemed invitation marks its linked entry accepted. */
  waitlist?: WaitlistStore;
  /**
   * Referral codes (FEATURE_REFERRALS): verify tries these before legacy
   * invitations, and every allowlisted login lazily gets a personal code.
   */
  referrals?: ReferralStore;
}

/** Restricted-session lifetime: long enough to open, review, and sign. */
export const SIGN_LINK_SESSION_TTL_SECONDS = 30 * 60;

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const registerAuthRoutes = (app: FastifyInstance, deps: AuthRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  // Issue an EIP-712 login challenge for a given address.
  app.get("/api/auth/challenge", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const address = q["address"];
    if (!address || !ETH_ADDRESS_RE.test(address)) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: "valid Ethereum address required (?address=0x...)",
      };
    }

    const rawChainId = q["chainId"];
    let chainId = 137;
    if (rawChainId) {
      const parsed = rawChainId.startsWith("0x")
        ? parseInt(rawChainId, 16)
        : parseInt(rawChainId, 10);
      if (!isNaN(parsed) && parsed > 0) chainId = parsed;
    }

    const challenge = createLoginChallenge(chainId);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await deps.challenges.create({
      nonce: challenge.nonce,
      walletAddress: address.toLowerCase(),
      chainId,
      issuedAt: challenge.issuedAt,
      expiresAt,
    });

    return {
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: expiresAt.toISOString(),
      typedData: challenge.typedData,
    };
  });

  // Verify a signed challenge; create a session if the address is allowlisted.
  // Rate-limited per IP: the plaintext referral-code namespace must not be
  // enumerable, and 20/min never throttles a human login.
  const verifyRateLimit = makeRateLimit({ limit: 20, windowMs: 60_000, scope: "auth-verify" });
  app.post("/api/auth/verify", { preHandler: [verifyRateLimit] }, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const address = typeof body["address"] === "string" ? body["address"].toLowerCase() : null;
    const nonce = typeof body["nonce"] === "string" ? body["nonce"] : null;
    const signature = typeof body["signature"] === "string" ? body["signature"] : null;
    const issuedAt = typeof body["issuedAt"] === "string" ? body["issuedAt"] : null;
    // Optional: the exact typedData payload the client signed (diagnostics only).
    const signedTypedData = body["signedTypedData"];

    if (!address || !nonce || !signature || !issuedAt) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "address, nonce, issuedAt, signature required" };
    }
    if (!ETH_ADDRESS_RE.test(address)) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "invalid Ethereum address" };
    }

    // Validate challenge exists and is unused/unexpired.
    const challenge = await deps.challenges.findByNonce(nonce);
    if (!challenge || challenge.usedAt !== null || challenge.expiresAt < new Date()) {
      reply.code(401);
      return { error: "INVALID_CHALLENGE", message: "nonce is invalid, expired, or already used" };
    }

    // Verify the signature using viem's standard EIP-712 verification.
    // issuedAt comes from the client (was in the signed typedData.message).
    const valid = await verifyLoginSignature(
      { nonce: challenge.nonce, issuedAt, chainId: challenge.chainId },
      signature,
      address,
    );

    // Access is open — the only thing that can block a login is an explicit
    // admin revocation. Audited regardless of outcome.
    const revoked = await deps.allowlist.isRevoked(address);
    await deps.auditStore.emit({
      actor: address,
      action: "allowlist.checked",
      subject: `wallet:${address}`,
      metadata: { revoked, sigValid: valid },
    });

    if (!valid) {
      // Diagnostics: recover the signer two ways to locate the divergence.
      //  - serverRecovered: from the server's reconstruction of the message
      //  - clientRecovered: from the exact typedData the client signed
      // If clientRecovered === claimed address but serverRecovered does not,
      // the bug is in the server's reconstruction (compare serverMessage vs the
      // client's payload). If clientRecovered is also wrong, the client signed
      // with a different account than it claims.
      const serverRecovered = await recoverLoginAddress(
        { nonce: challenge.nonce, issuedAt, chainId: challenge.chainId },
        signature,
      );
      const clientRecovered =
        signedTypedData !== undefined
          ? await recoverFromRawTypedData(signedTypedData, signature)
          : null;

      const serverMessage = {
        domain: { name: "MX2 Terminal", version: "1", chainId: challenge.chainId },
        primaryType: "Login",
        message: { statement: "Sign in to MX2 Terminal", nonce: challenge.nonce, issuedAt },
      };

      req.log.warn(
        {
          event: "auth.verify.signature_mismatch",
          claimedAddress: address,
          serverRecovered,
          clientRecovered,
          chainId: challenge.chainId,
          issuedAt,
          nonce: challenge.nonce,
          serverMessage,
          clientTypedData: signedTypedData ?? null,
        },
        "EIP-712 signature did not match claimed address",
      );

      reply.code(401);
      return {
        error: "INVALID_SIGNATURE",
        message: "signature does not match address",
        debug: {
          claimedAddress: address,
          serverRecovered: serverRecovered ?? "recovery_failed",
          clientRecovered: clientRecovered ?? "not_provided_or_failed",
          chainId: challenge.chainId,
          issuedAt,
          nonce: challenge.nonce,
          serverMessage,
          clientTypedData: signedTypedData ?? null,
        },
      };
    }

    // The ONLY signature-valid login we refuse: an explicitly revoked wallet.
    // There is no allowlist to be on — a wallet that has never been seen here
    // signs in exactly like a returning one.
    if (revoked) {
      reply.code(403);
      return {
        error: "ACCESS_REVOKED",
        message:
          "Access for this wallet has been revoked. Contact support if you believe this is a mistake.",
      };
    }

    // Referral / invitation codes are ATTRIBUTION, never a gate. A code that
    // cannot be redeemed is audited and ignored: losing your login because a
    // referral link was stale is never the right trade. Redemption still binds
    // atomically to the signature-verified wallet server-side, so a client can
    // never redeem for a wallet other than the one that signed (brief §4.3.3),
    // and a replay by the SAME wallet stays an idempotent success.
    //
    // Only unattributed wallets may redeem. Access no longer depends on a code,
    // so without this an established user could burn a seat off any code and
    // hand a referrer credit for someone they never brought.
    const existingEntry = await deps.allowlist.findEntry(address);
    const attributable = existingEntry === null || existingEntry.addedBy === "system:open-access";
    const inviteCode = typeof body["inviteCode"] === "string" ? body["inviteCode"].trim() : null;
    let attribution: { addedBy: string; note: string | null } | null = null;
    if (inviteCode && attributable && (deps.referrals || deps.invitations)) {
      // Referral codes first (plaintext handles); legacy hashed invitations
      // remain redeemable through the same field so outstanding one-time codes
      // keep working.
      let redeemed = false;
      if (deps.referrals) {
        const result = await deps.referrals.redeem(inviteCode, address);
        if (result.outcome === "redeemed" || result.outcome === "already_redeemed_by_wallet") {
          attribution = { addedBy: `referral:${result.code.id}`, note: result.code.code };
          await deps.auditStore.emit({
            actor: address,
            action: "referral.redeemed",
            subject: `referral_code:${result.code.id}`,
            metadata: {
              code: result.code.code,
              referrerWallet: result.redemption.referrerWallet,
              idempotentReplay: result.outcome === "already_redeemed_by_wallet",
            },
          });
          redeemed = true;
        } else if (result.reason !== "not_found") {
          await deps.auditStore.emit({
            actor: address,
            action: "referral.redemption_rejected",
            subject: `wallet:${address}`,
            metadata: { reason: result.reason, loginAllowed: true },
          });
        }
        // not_found falls through to the legacy invitation path.
      }
      if (!redeemed && deps.invitations) {
        const result = await deps.invitations.redeem(hashInviteCode(inviteCode), address);
        if (result.outcome === "redeemed" || result.outcome === "already_redeemed_by_wallet") {
          attribution = {
            addedBy: `invite:${result.invitation.id}`,
            note: result.invitation.note,
          };
          await deps.auditStore.emit({
            actor: address,
            action: "invite.redeemed",
            subject: `invitation:${result.invitation.id}`,
            metadata: { idempotentReplay: result.outcome === "already_redeemed_by_wallet" },
          });
          if (result.invitation.waitlistEntryId && deps.waitlist) {
            await deps.waitlist.updateStatus(result.invitation.waitlistEntryId, "accepted");
          }
        } else {
          await deps.auditStore.emit({
            actor: address,
            action: "invite.redemption_rejected",
            subject: `wallet:${address}`,
            metadata: { reason: result.reason, loginAllowed: true },
          });
        }
      }
    }

    // Record first contact so the admin panel and referral roster stay
    // complete. Only on INSERT — `add` upserts addedBy/note, and rewriting them
    // on every login would erase the referral attribution captured above.
    if (!existingEntry) {
      await deps.allowlist.add(
        address,
        attribution?.addedBy ?? "system:open-access",
        // `attribution.note` is legitimately null for codes without one — it
        // must not fall through to the open-access placeholder.
        attribution ? attribution.note : "first sign-in (open access)",
      );
      await deps.auditStore.emit({
        actor: address,
        action: "allowlist.auto_added",
        subject: `wallet:${address}`,
        metadata: { via: attribution?.addedBy ?? "open-access" },
      });
    } else if (attribution && existingEntry.addedBy === "system:open-access") {
      // A wallet that signed in before redeeming its code keeps the credit.
      await deps.allowlist.add(address, attribution.addedBy, attribution.note);
    }

    // Mark nonce used.
    await deps.challenges.markUsed(nonce);

    // Upsert user record.
    await deps.users.upsert(address);

    // Every allowlisted user gets a personal referral code (grandfathered
    // wallets included — this is the lazy creation point for them). Fail-soft:
    // login must never break because code minting hiccuped.
    if (deps.referrals) {
      try {
        await deps.referrals.ensurePersonalCode(address, deps.config.referrals.defaultMaxUses);
      } catch (error) {
        req.log.warn({ event: "referral.personal_code_failed", address, error }, "personal code");
      }
    }

    // Create session.
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + deps.config.session.ttlSeconds * 1000);
    await deps.sessions.create({ userWallet: address, tokenHash, expiresAt });

    // Audit the successful login.
    await deps.auditStore.emit({
      actor: address,
      action: "auth.login",
      subject: `wallet:${address}`,
      metadata: { method: "eip712" },
    });

    // NOTE: signing in deliberately does NOT provision an Arima (Privy) trading
    // wallet. The main/connected wallet is the default trading path; the Arima
    // Wallet is an explicit opt-in Beta feature created only via
    // POST /api/trading-wallet/provision after the user confirms (brief §5.3.5).

    // Set httpOnly session cookie.
    void reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: deps.config.session.crossSite ? "none" : "strict",
      path: "/",
      secure: deps.config.session.cookieSecure,
      maxAge: deps.config.session.ttlSeconds,
    });

    return { ok: true, address };
  });

  // ── POST /api/auth/sign-link/exchange ──────────────────────────────────────
  // Trades a single-use sign-link token (minted into a Telegram notification)
  // for a SHORT RESTRICTED session scoped to exactly one trigger. The scoped
  // session can view/confirm/dismiss that trigger and submit ITS pre-signed
  // order — nothing else (require-auth rejects it everywhere else). A leaked
  // link can therefore only ever show one prepared order; executing still
  // requires the main wallet's EIP-712 signature.
  if (deps.signTokens) {
    const signTokens = deps.signTokens;
    const exchangeRateLimit = makeRateLimit({ limit: 10, windowMs: 60_000, scope: "sign-link" });
    app.post(
      "/api/auth/sign-link/exchange",
      { preHandler: [exchangeRateLimit] },
      async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const rawToken = typeof body["token"] === "string" ? body["token"] : null;
        if (!rawToken || rawToken.length < 16 || rawToken.length > 128) {
          reply.code(400);
          return { error: "INVALID_REQUEST", message: "token is required" };
        }
        const consumed = await signTokens.consume(
          createHash("sha256").update(rawToken, "utf8").digest("hex"),
        );
        if (!consumed) {
          reply.code(401);
          return {
            error: "INVALID_TOKEN",
            message: "This sign link is invalid, expired, or already used.",
          };
        }
        const sessionToken = generateSessionToken();
        const expiresAt = new Date(Date.now() + SIGN_LINK_SESSION_TTL_SECONDS * 1000);
        await deps.sessions.create({
          userWallet: consumed.walletAddress,
          tokenHash: hashSessionToken(sessionToken),
          expiresAt,
          scope: { type: "trigger", triggerId: consumed.triggerId },
        });
        await deps.auditStore.emit({
          actor: consumed.walletAddress,
          action: "auth.scoped_session_created",
          subject: `trigger:${consumed.triggerId}`,
          metadata: { via: "sign_link", ttlSeconds: SIGN_LINK_SESSION_TTL_SECONDS },
        });
        void reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
          httpOnly: true,
          sameSite: deps.config.session.crossSite ? "none" : "strict",
          path: "/",
          secure: deps.config.session.cookieSecure,
          maxAge: SIGN_LINK_SESSION_TTL_SECONDS,
        });
        return {
          ok: true,
          triggerId: consumed.triggerId,
          walletAddress: consumed.walletAddress,
          expiresAt: expiresAt.toISOString(),
        };
      },
    );
  }

  // ── POST /api/auth/telegram-miniapp ────────────────────────────────────────
  // Telegram Mini App login: verifies the webview's HMAC-signed initData
  // against the bot token, resolves the LINKED wallet (linking always happens
  // through the code handshake first), and mints a RESTRICTED wallet-scoped
  // session — it can view/sign awaiting triggers, nothing else.
  if (
    deps.notificationChannels &&
    deps.config.features.telegramMiniapp &&
    deps.config.notifications.telegramBotToken
  ) {
    const channels = deps.notificationChannels;
    const botToken = deps.config.notifications.telegramBotToken;
    const miniappRateLimit = makeRateLimit({ limit: 20, windowMs: 60_000, scope: "miniapp-auth" });
    app.post(
      "/api/auth/telegram-miniapp",
      { preHandler: [miniappRateLimit] },
      async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const initData = typeof body["initData"] === "string" ? body["initData"] : null;
        if (!initData || initData.length > 4096) {
          reply.code(400);
          return { error: "INVALID_REQUEST", message: "initData is required" };
        }
        const verified = verifyTelegramInitData(initData, botToken);
        if (!verified) {
          reply.code(401);
          return { error: "INVALID_INIT_DATA", message: "Telegram login could not be verified." };
        }
        const channel = await channels.findActiveByExternalId("telegram", verified.userId);
        if (!channel) {
          reply.code(403);
          return {
            error: "NOT_LINKED",
            message: "Link your Telegram account from the app's Wallet page first.",
          };
        }
        const sessionToken = generateSessionToken();
        const expiresAt = new Date(Date.now() + SIGN_LINK_SESSION_TTL_SECONDS * 1000);
        await deps.sessions.create({
          userWallet: channel.walletAddress,
          tokenHash: hashSessionToken(sessionToken),
          expiresAt,
          scope: { type: "telegram_wallet" },
        });
        await deps.auditStore.emit({
          actor: channel.walletAddress,
          action: "auth.scoped_session_created",
          subject: `notification_channel:${channel.id}`,
          metadata: { via: "telegram_miniapp", ttlSeconds: SIGN_LINK_SESSION_TTL_SECONDS },
        });
        void reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
          httpOnly: true,
          sameSite: deps.config.session.crossSite ? "none" : "strict",
          path: "/",
          secure: deps.config.session.cookieSecure,
          maxAge: SIGN_LINK_SESSION_TTL_SECONDS,
        });
        return {
          ok: true,
          walletAddress: channel.walletAddress,
          expiresAt: expiresAt.toISOString(),
        };
      },
    );
  }

  // Revoke the current session.
  app.post("/api/auth/logout", { preHandler: requireAuth }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await deps.sessions.revoke(hashSessionToken(token));
    }
    void reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  // Return the authenticated user's identity.
  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    const user = req.user;
    if (!user) {
      // Guard (requireAuth guarantees this is set, but types need it)
      return UNAUTHORIZED_BODY;
    }
    const entry = await deps.allowlist.findEntry(user.walletAddress);
    // The Polymarket Data API keys off the deposit (Gnosis Safe) wallet, not the
    // signer EOA. Derive it deterministically so the client never has to ask the
    // user to paste it. Fail-soft: null lets the UI fall back to a manual override.
    let depositWallet: string | null = null;
    try {
      depositWallet = deriveDepositWallet(user.walletAddress);
    } catch {
      depositWallet = null;
    }
    return {
      address: user.walletAddress,
      // "Has access", not "is on a list": true unless explicitly revoked. A
      // wallet with no access record at all is a normal, allowed user, and
      // requireAuth already guarantees this session is not a revoked one.
      allowlisted: entry?.isActive !== false,
      depositWallet,
      // Admin-panel gate is server-enforced; this only drives nav visibility.
      isAdmin: deps.config.referrals.adminWallets.includes(user.walletAddress),
    };
  });
};
