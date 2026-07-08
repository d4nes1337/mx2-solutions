import { getAddress } from "viem";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  SessionStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
  OrderIntentStore,
  RuntimeFlagStore,
  TradingAccountRow,
} from "@mx2/db";
import type {
  AuthenticatedClobClient,
  GeoblockClient,
  L2Credentials,
  SignedClobOrder,
} from "@mx2/polymarket-client";
import { SignedClobOrderSchema } from "@mx2/polymarket-client";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeGeoblockCheck } from "../middleware/geoblock.js";
import { encryptCredentials, decryptCredentials, fingerprintSecret } from "../auth/crypto.js";

export interface TradeRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  tradingAccounts: TradingAccountStore;
  accountClobCredentials: TradingAccountClobCredentialStore;
  orderIntents: OrderIntentStore;
  runtimeFlags: RuntimeFlagStore;
  tradingClobClient: AuthenticatedClobClient;
  geoblockClient: GeoblockClient;
}

const isTradingPaused = async (deps: TradeRoutesDeps): Promise<boolean> => {
  const flag = await deps.runtimeFlags.get("trading_paused");
  return flag?.value === "true";
};

const assertTradingEnabled = async (
  deps: TradeRoutesDeps,
  reply: FastifyReply,
): Promise<boolean> => {
  if (!deps.config.features.liveTrading) {
    reply.code(503);
    await reply.send({ error: "TRADING_DISABLED", message: "Live trading is currently disabled." });
    return false;
  }
  const paused = await isTradingPaused(deps);
  if (paused) {
    reply.code(503);
    await reply.send({
      error: "TRADING_PAUSED",
      message: "Trading has been administratively paused.",
    });
    return false;
  }
  if (!deps.config.encryptionMasterKey) {
    reply.code(500);
    await reply.send({
      error: "CONFIG_ERROR",
      message: "Trading infrastructure is not configured.",
    });
    return false;
  }
  return true;
};

const getDecryptedAccountCreds = async (
  deps: TradeRoutesDeps,
  tradingAccountId: string,
  reply: FastifyReply,
): Promise<L2Credentials | null> => {
  const row = await deps.accountClobCredentials.find(tradingAccountId);
  if (!row) {
    reply.code(400);
    await reply.send({
      error: "CLOB_CREDENTIALS_NOT_SET",
      message:
        "CLOB API credentials are not set for this trading account. Set up credentials first.",
    });
    return null;
  }
  return decryptCredentials<L2Credentials>(
    row.encryptedCreds as Parameters<typeof decryptCredentials>[0],
    deps.config.encryptionMasterKey!,
  );
};

/** CLOB POLY_ADDRESS must be EIP-55 checksummed; session wallets are lowercase. */
const clobSignerAddress = (walletAddress: string): `0x${string}` =>
  getAddress(walletAddress as `0x${string}`);

const resolveTradingAccount = async (
  deps: TradeRoutesDeps,
  ownerWalletAddress: string,
  rawId: unknown,
  reply: FastifyReply,
): Promise<TradingAccountRow | null> => {
  const id = typeof rawId === "string" && rawId.trim() ? rawId : null;
  const account = id
    ? await deps.tradingAccounts.findByOwner(ownerWalletAddress, id)
    : await deps.tradingAccounts.getPrimary(ownerWalletAddress);
  if (!account) {
    reply.code(400);
    await reply.send({
      error: "TRADING_ACCOUNT_NOT_SET",
      message:
        "Select a trading account first. Call GET /api/trading-accounts to initialize defaults.",
    });
    return null;
  }
  return account;
};

const accountNotReady = async (
  reply: FastifyReply,
  account: TradingAccountRow,
): Promise<true | null> => {
  if (account.kind === "internal_privy" && account.status !== "ready") {
    reply.code(409);
    await reply.send({
      error: "TRADING_ACCOUNT_NOT_READY",
      message:
        "No-signature trading needs a Polymarket-registered deposit wallet before orders can be submitted.",
      tradingAccountId: account.id,
      status: account.status,
      nextAction:
        account.status === "needs_funding" && account.funderAddress
          ? "top_up"
          : "activate_deposit_wallet",
    });
    return null;
  }
  if (!account.funderAddress) {
    reply.code(409);
    await reply.send({
      error: "FUNDER_NOT_SET",
      message: "This trading account has no funder/deposit wallet configured.",
      tradingAccountId: account.id,
    });
    return null;
  }
  return true;
};

export const registerTradeRoutes = (app: FastifyInstance, deps: TradeRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });
  const geoblockCheck = makeGeoblockCheck({
    geoblockClient: deps.geoblockClient,
    auditStore: deps.auditStore,
  });

  // ── GET /api/trade/status ──────────────────────────────────────────────────
  // Public: returns feature flag state and (on success) geoblock result for the caller's IP.
  app.get("/api/trade/status", async (req) => {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip;
    const geoResult = await deps.geoblockClient.check(ip);
    const paused = await isTradingPaused(deps);
    return {
      tradingEnabled: deps.config.features.liveTrading && !paused,
      featureFlag: deps.config.features.liveTrading,
      runtimePaused: paused,
      geoblock: geoResult.ok
        ? { status: geoResult.value.status, country: geoResult.value.country }
        : { status: "unknown", error: geoResult.error.code },
    };
  });

  // ── GET /api/trade/clob-time ───────────────────────────────────────────────
  // Public. Polymarket CLOB server unix timestamp — clients must sign L1 ClobAuth
  // with this value, not local Date.now(), or auth fails with "Invalid L1 headers".
  app.get("/api/trade/clob-time", async (_req, reply) => {
    const result = await deps.tradingClobClient.getServerTime();
    if (!result.ok) {
      reply.code(502);
      return { error: "CLOB_TIME_FAILED", message: result.error.message };
    }
    return { timestamp: result.value };
  });

  // ── POST /api/trade/credentials/setup ─────────────────────────────────────
  // Authenticated. Derives L2 CLOB API keys from a user-provided L1 signature.
  // This is a one-time setup per user; re-callable if credentials need rotation.
  app.post("/api/trade/credentials/setup", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const body = req.body as Record<string, unknown>;
    const account = await resolveTradingAccount(
      deps,
      user.walletAddress,
      body["tradingAccountId"],
      reply,
    );
    if (!account) return;

    if (!deps.config.encryptionMasterKey) {
      reply.code(500);
      return { error: "CONFIG_ERROR", message: "Trading infrastructure is not configured." };
    }

    // Resolve the L1 ClobAuth signature + the address it attests. Two modes:
    //  - browser path: the client signs ClobAuth and posts {l1Signature,timestamp,nonce}.
    //  - Privy path: the server signs ClobAuth for the embedded wallet (no popup),
    //    keyed off the embedded address (which the CLOB sees as POLY_ADDRESS).
    let signingAddress: `0x${string}`;
    let l1Signature: string;
    let timestamp: string;
    let nonce: string;

    const bodySig = typeof body["l1Signature"] === "string" ? body["l1Signature"] : null;
    if (bodySig) {
      const ts = typeof body["timestamp"] === "string" ? body["timestamp"] : null;
      const nc = typeof body["nonce"] === "string" ? body["nonce"] : null;
      if (!ts || !nc) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "l1Signature, timestamp, and nonce required" };
      }
      // Session wallet is lowercase; CLOB L1 auth expects checksummed POLY_ADDRESS
      // matching the address field in the signed ClobAuth EIP-712 message.
      signingAddress = clobSignerAddress(account.signerAddress);
      l1Signature = bodySig;
      timestamp = ts;
      nonce = nc;
    } else {
      reply.code(409);
      return {
        error: "MANUAL_SIGNATURE_REQUIRED",
        message:
          "This trading account is not ready for server-side credential setup. Sign the CLOB auth message in the selected wallet.",
      };
    }

    const result = await deps.tradingClobClient.deriveApiKey({
      address: signingAddress,
      l1Signature,
      timestamp,
      nonce,
    });

    if (!result.ok) {
      req.log.warn(
        {
          event: "trade.credentials.derive_failed",
          wallet: user.walletAddress,
          tradingAccountId: account.id,
          error: result.error,
        },
        "CLOB key derivation failed",
      );
      reply.code(502);
      const clockSkewHint =
        result.error.statusCode === 401
          ? " CLOB L1 auth requires signing with Polymarket server time (GET /api/trade/clob-time), not local clock."
          : "";
      return { error: "CLOB_DERIVE_FAILED", message: result.error.message + clockSkewHint };
    }

    const encrypted = encryptCredentials(result.value, deps.config.encryptionMasterKey);
    await deps.accountClobCredentials.upsert(account.id, user.walletAddress, encrypted);
    if (account.kind === "external_wallet") await deps.tradingAccounts.markReady(account.id);
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trade.credentials.setup" as const,
      subject: `trading_account:${account.id}`,
      metadata: {
        apiKeyFingerprint: fingerprintSecret(result.value.apiKey),
        signerAddress: account.signerAddress,
      },
    });

    return { ok: true, apiKey: result.value.apiKey, tradingAccountId: account.id };
  });

  // ── GET /api/trade/account ─────────────────────────────────────────────────
  // Authenticated + trading enabled + geoblock check.
  app.get(
    "/api/trade/account",
    { preHandler: [requireAuth, geoblockCheck] },
    async (req, reply) => {
      if (!(await assertTradingEnabled(deps, reply))) return;
      const user = req.user!;
      const account = await resolveTradingAccount(
        deps,
        user.walletAddress,
        (req.query as Record<string, unknown>)["tradingAccountId"],
        reply,
      );
      if (!account) return;
      const creds = await getDecryptedAccountCreds(deps, account.id, reply);
      if (!creds) return;
      const signer = clobSignerAddress(account.signerAddress);

      const balResult = await deps.tradingClobClient.getBalanceAllowance(signer, creds);
      const ordersResult = await deps.tradingClobClient.getOpenOrders(signer, creds);

      return {
        tradingAccountId: account.id,
        signerAddress: account.signerAddress,
        funderAddress: account.funderAddress,
        balance: balResult.ok ? balResult.value.balance : null,
        allowance: balResult.ok ? balResult.value.allowance : null,
        balanceError: balResult.ok ? null : balResult.error.code,
        openOrders: ordersResult.ok ? ordersResult.value : [],
        openOrdersError: ordersResult.ok ? null : ordersResult.error.code,
      };
    },
  );

  // ── POST /api/trade/orders/preview ────────────────────────────────────────
  // Authenticated + geoblock. Does NOT require trading enabled (preview is safe).
  // Returns order parameters for the user to review before signing.
  app.post(
    "/api/trade/orders/preview",
    { preHandler: [requireAuth, geoblockCheck] },
    async (req, reply) => {
      const user = req.user!;
      const body = req.body as Record<string, unknown>;
      const account = await resolveTradingAccount(
        deps,
        user.walletAddress,
        body["tradingAccountId"],
        reply,
      );
      if (!account) return;
      if (!(await accountNotReady(reply, account))) return;

      const conditionId = typeof body["conditionId"] === "string" ? body["conditionId"] : null;
      const tokenId = typeof body["tokenId"] === "string" ? body["tokenId"] : null;
      const side = body["side"] === "BUY" || body["side"] === "SELL" ? body["side"] : null;
      const price = typeof body["price"] === "string" ? body["price"] : null;
      const size = typeof body["size"] === "string" ? body["size"] : null;
      const orderType = ["GTC", "GTD", "FOK"].includes(body["orderType"] as string)
        ? (body["orderType"] as string)
        : "GTC";
      const funder = account.funderAddress;

      if (!conditionId || !tokenId || !side || !price || !size || !funder) {
        reply.code(400);
        return {
          error: "INVALID_REQUEST",
          message: "conditionId, tokenId, side, price, size, funder required",
        };
      }

      const priceNum = parseFloat(price);
      const sizeNum = parseFloat(size);
      if (isNaN(priceNum) || priceNum <= 0 || priceNum >= 1) {
        reply.code(400);
        return { error: "INVALID_PRICE", message: "price must be between 0 and 1 (exclusive)" };
      }
      if (isNaN(sizeNum) || sizeNum <= 0) {
        reply.code(400);
        return { error: "INVALID_SIZE", message: "size must be positive" };
      }

      const maxSpend = (priceNum * sizeNum).toFixed(6);
      const timestamp = Math.floor(Date.now() / 1000).toString();

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "trade.order.preview" as const,
        subject: `trading_account:${account.id}`,
        metadata: { conditionId, tokenId, side, price, size, orderType, funder },
      });

      return {
        tradingAccountId: account.id,
        tradingAccountLabel: account.label,
        signingMode: account.signingMode,
        requiresSignature: account.signingMode === "browser",
        conditionId,
        tokenId,
        side,
        price,
        size,
        orderType,
        funder,
        maxSpend,
        builderCode: deps.config.polymarket.builderCode ?? null,
        signatureType: account.signatureType,
        timestamp,
        note:
          account.signingMode === "browser"
            ? "This wallet trades with manual signatures. Your browser signs the CTF Exchange order before submission."
            : "This wallet is configured for server-side signing. No browser wallet popup is required once the deposit wallet is active.",
        warning: deps.config.features.liveTrading
          ? "Live trading is ENABLED. Submitting this order will use real funds."
          : "Live trading is DISABLED. This preview is for demonstration only.",
      };
    },
  );

  // ── POST /api/trade/orders ─────────────────────────────────────────────────
  // Authenticated + trading enabled + geoblock. Idempotent by idempotencyKey.
  app.post(
    "/api/trade/orders",
    { preHandler: [requireAuth, geoblockCheck] },
    async (req, reply) => {
      if (!(await assertTradingEnabled(deps, reply))) return;
      const user = req.user!;
      const body = req.body as Record<string, unknown>;
      const account = await resolveTradingAccount(
        deps,
        user.walletAddress,
        body["tradingAccountId"],
        reply,
      );
      if (!account) return;
      if (!(await accountNotReady(reply, account))) return;

      const idempotencyKey =
        typeof body["idempotencyKey"] === "string" ? body["idempotencyKey"] : null;
      const conditionId = typeof body["conditionId"] === "string" ? body["conditionId"] : null;
      // Human-readable price/size are recorded for the intent/audit trail.
      const price = typeof body["price"] === "string" ? body["price"] : null;
      const size = typeof body["size"] === "string" ? body["size"] : null;
      const orderType = (
        ["GTC", "GTD", "FOK"].includes(body["orderType"] as string) ? body["orderType"] : "GTC"
      ) as "GTC" | "GTD" | "FOK";

      if (!idempotencyKey || !conditionId || !price || !size) {
        reply.code(400);
        return {
          error: "INVALID_REQUEST",
          message: "idempotencyKey, conditionId, price, size are required",
        };
      }

      // Idempotency: if a matching intent already exists, return its current state.
      const existing = await deps.orderIntents.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.walletAddress !== user.walletAddress) {
          reply.code(409);
          return {
            error: "IDEMPOTENCY_CONFLICT",
            message: "Idempotency key belongs to a different user.",
          };
        }
        return {
          intentId: existing.id,
          clobOrderId: existing.clobOrderId,
          status: existing.status,
          idempotent: true,
        };
      }

      // Rate-limit guardrail (shared with the auto-execution path via the same
      // order_intents count). Caps runaway submission from any one wallet.
      const recentOrders = await deps.orderIntents.countRecentByWallet(
        user.walletAddress,
        new Date(Date.now() - 60_000),
      );
      if (recentOrders >= deps.config.limits.orderRateLimitPerMin) {
        await deps.auditStore.emit({
          actor: user.walletAddress,
          action: "order.rate_limited",
          subject: `idem:${idempotencyKey}`,
          metadata: { recent: recentOrders, limit: deps.config.limits.orderRateLimitPerMin },
        });
        reply.code(429);
        return {
          error: "RATE_LIMITED",
          message: "Too many orders in the last minute. Please slow down.",
        };
      }

      // Obtain a signed CLOB order. The selected trading account, not a global
      // feature flag, decides whether a browser signature is required.
      let signedOrder: SignedClobOrder;
      let tokenId: string;
      let side: "BUY" | "SELL";
      let funder: string;
      let clobAddress: `0x${string}`;

      if (account.signingMode === "server") {
        reply.code(409);
        return {
          error: "RELAYER_ORDER_PATH_NOT_ENABLED",
          message:
            "No-signature trading requires the Polymarket deposit-wallet relayer order path. This account is not enabled for live server-side orders yet.",
          tradingAccountId: account.id,
        };
      } else {
        // Browser-signed account: the client builds + signs the CLOB order struct
        // (EIP-712 over the CTF Exchange domain). We validate ownership-critical
        // fields against the selected account and forward it verbatim.
        const parsedOrder = SignedClobOrderSchema.safeParse(body["order"]);
        if (!parsedOrder.success) {
          reply.code(400);
          return { error: "INVALID_REQUEST", message: "a signed `order` struct is required" };
        }
        signedOrder = parsedOrder.data;
        const expectedSigner = account.signerAddress.toLowerCase();
        const expectedFunder = account.funderAddress?.toLowerCase();
        if (
          signedOrder.signer.toLowerCase() !== expectedSigner ||
          !expectedFunder ||
          signedOrder.maker.toLowerCase() !== expectedFunder ||
          signedOrder.signatureType !== account.signatureType
        ) {
          reply.code(400);
          return {
            error: "ORDER_ACCOUNT_MISMATCH",
            message:
              "Signed order does not match the selected trading account signer, funder, or signature type.",
          };
        }
        tokenId = signedOrder.tokenId;
        side = signedOrder.side === "BUY" || signedOrder.side === 0 ? "BUY" : "SELL";
        funder = signedOrder.maker;
        clobAddress = clobSignerAddress(account.signerAddress);
      }

      const creds = await getDecryptedAccountCreds(deps, account.id, reply);
      if (!creds) return;

      // Create the intent record before submission so failures are audited.
      const intent = await deps.orderIntents.create({
        walletAddress: user.walletAddress,
        tradingAccountId: account.id,
        idempotencyKey,
        conditionId,
        tokenId,
        side,
        price,
        size,
        orderType,
        funder,
        signer: account.signerAddress,
        signatureType: account.signatureType,
        signingMode: account.signingMode,
        metadata: {
          builderCode: deps.config.polymarket.builderCode,
          tradingAccountKind: account.kind,
          tradingAccountLabel: account.label,
        },
      });

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "order.intent",
        subject: `intent:${intent.id}`,
        metadata: {
          conditionId,
          tokenId,
          side,
          price,
          size,
          orderType,
          funder,
          tradingAccountId: account.id,
        },
      });

      const submitResult = await deps.tradingClobClient.submitOrder(
        signedOrder,
        orderType,
        creds,
        clobAddress,
        idempotencyKey,
      );

      if (!submitResult.ok) {
        await deps.orderIntents.updateStatus(intent.id, "failed", {
          errorMessage: submitResult.error.message,
        });
        await deps.auditStore.emit({
          actor: user.walletAddress,
          action: "order.failed",
          subject: `intent:${intent.id}`,
          metadata: { error: submitResult.error.code, message: submitResult.error.message },
        });
        req.log.warn(
          { event: "trade.order.failed", intentId: intent.id, error: submitResult.error },
          "Order submission failed",
        );
        reply.code(502);
        return {
          error: "ORDER_SUBMIT_FAILED",
          message: submitResult.error.message,
          intentId: intent.id,
        };
      }

      const clobOrderId = submitResult.value.orderID;
      await deps.orderIntents.updateStatus(intent.id, "submitted", { clobOrderId });
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "order.submitted",
        subject: `intent:${intent.id}`,
        metadata: { clobOrderId, status: submitResult.value.status, tradingAccountId: account.id },
      });

      reply.code(201);
      return {
        intentId: intent.id,
        clobOrderId,
        status: "submitted",
        tradingAccountId: account.id,
      };
    },
  );

  // ── DELETE /api/trade/orders/:id ──────────────────────────────────────────
  // Authenticated + trading enabled + geoblock.
  app.delete(
    "/api/trade/orders/:id",
    { preHandler: [requireAuth, geoblockCheck] },
    async (req, reply) => {
      if (!(await assertTradingEnabled(deps, reply))) return;
      const user = req.user!;
      const params = req.params as { id: string };
      const query = req.query as Record<string, unknown>;
      const clobOrderId = params.id;

      if (!clobOrderId) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "order id required in path" };
      }

      const account = await resolveTradingAccount(
        deps,
        user.walletAddress,
        query["tradingAccountId"],
        reply,
      );
      if (!account) return;
      const creds = await getDecryptedAccountCreds(deps, account.id, reply);
      if (!creds) return;

      const result = await deps.tradingClobClient.cancelOrder(
        clobOrderId,
        creds,
        clobSignerAddress(account.signerAddress),
      );

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: result.ok ? "order.cancelled" : "order.cancel_failed",
        subject: `clob_order:${clobOrderId}`,
        metadata: {
          ok: result.ok,
          error: result.ok ? null : result.error.code,
          tradingAccountId: account.id,
        },
      });

      if (!result.ok) {
        reply.code(502);
        return { error: "CANCEL_FAILED", message: result.error.message };
      }

      // Update any matching intent to cancelled.
      const intents = await deps.orderIntents.listByWallet(user.walletAddress, 100);
      const matching = intents.find((i) => i.clobOrderId === clobOrderId);
      if (matching) {
        await deps.orderIntents.updateStatus(matching.id, "cancelled");
      }

      return { ok: true, clobOrderId };
    },
  );

  // ── GET /api/trade/orders ─────────────────────────────────────────────────
  // Authenticated. Returns the user's order intent history.
  app.get("/api/trade/orders", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const intents = await deps.orderIntents.listByWallet(user.walletAddress);
    return { orders: intents };
  });
};
