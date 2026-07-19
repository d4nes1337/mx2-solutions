import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  ChallengeStore,
  UserStore,
  SessionStore,
  AllowlistStore,
  AuditStore,
  NotificationChannelStore,
  PrivyWalletStore,
  SignLinkTokenStore,
  TradingAccountStore,
} from "@mx2/db";
import type { AppConfig } from "@mx2/config";
import type { TradingSigner } from "@mx2/trading-signer";
import { ensureTradingWalletProvisioned } from "../trade/provision-wallet.js";
import {
  createLoginChallenge,
  verifyLoginSignature,
  recoverLoginAddress,
  recoverFromRawTypedData,
  CHALLENGE_TTL_MS,
} from "../auth/eip712.js";
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from "../auth/session.js";
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
  tradingSigner: TradingSigner;
  privyWallets: PrivyWalletStore;
  tradingAccounts: TradingAccountStore;
  /** Sign-link tokens (FEATURE_NOTIFICATIONS); the exchange route needs it. */
  signTokens?: SignLinkTokenStore;
  /** Channel links (FEATURE_TELEGRAM_MINIAPP); the Mini App login needs it. */
  notificationChannels?: NotificationChannelStore;
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
  app.post("/api/auth/verify", async (req, reply) => {
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

    // Emit allowlist audit event regardless of outcome.
    let allowed = await deps.allowlist.isAllowed(address);
    await deps.auditStore.emit({
      actor: address,
      action: "allowlist.checked",
      subject: `wallet:${address}`,
      metadata: { allowed, sigValid: valid },
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

    // Open beta: after a VALID signature, auto-allowlist unknown wallets. The
    // allowlist table stays the source of truth (revoking a wallet still works;
    // AllowlistStore.add upserts and re-activates). Behind FEATURE_OPEN_BETA.
    if (!allowed && deps.config.features.openBeta) {
      await deps.allowlist.add(address, "system:open-beta", "auto-allowlisted (open beta)");
      await deps.auditStore.emit({
        actor: address,
        action: "allowlist.auto_added",
        subject: `wallet:${address}`,
        metadata: { flag: "FEATURE_OPEN_BETA" },
      });
      allowed = true;
    }

    if (!allowed) {
      reply.code(403);
      return { error: "NOT_ALLOWLISTED", message: "this address is not on the beta allowlist" };
    }

    // Mark nonce used.
    await deps.challenges.markUsed(nonce);

    // Upsert user record.
    await deps.users.upsert(address);

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

    // Auto-provision a Privy trading wallet so every user is trade-ready straight
    // after login. Idempotent and fail-soft: a Privy hiccup must never block login —
    // the user can still retry via POST /api/trading-wallet/provision.
    if (deps.config.features.privySigning) {
      try {
        const result = await ensureTradingWalletProvisioned(
          {
            config: deps.config,
            auditStore: deps.auditStore,
            tradingSigner: deps.tradingSigner,
            privyWallets: deps.privyWallets,
            tradingAccounts: deps.tradingAccounts,
          },
          address,
        );
        if (!result.ok) {
          req.log.warn(
            { walletAddress: address, code: result.code, message: result.message },
            "auto-provision of trading wallet failed on login",
          );
        }
      } catch (err) {
        req.log.error(
          { err, walletAddress: address },
          "auto-provision of trading wallet threw on login",
        );
      }
    }

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
      return { error: "Unauthorized" };
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
      allowlisted: entry?.isActive === true,
      depositWallet,
    };
  });
};
