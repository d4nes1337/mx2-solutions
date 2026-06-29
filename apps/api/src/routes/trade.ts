import { getAddress } from "viem";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  SessionStore,
  ClobCredentialStore,
  OrderIntentStore,
  RuntimeFlagStore,
  PrivyWalletStore,
  DelegationStore,
} from "@mx2/db";
import type {
  AuthenticatedClobClient,
  GeoblockClient,
  L2Credentials,
  TickSize,
  SignedClobOrder,
} from "@mx2/polymarket-client";
import {
  SignedClobOrderSchema,
  buildAndSignEoaOrder,
  buildClobAuthTypedData,
} from "@mx2/polymarket-client";
import type { TradingSigner } from "@mx2/trading-signer";
import { makeRequireAuth } from "../middleware/require-auth.js";
// TODO(geoblock): TEMPORARILY DISABLED for local testing — restore before any staging/live use.
// import { makeGeoblockCheck } from "../middleware/geoblock.js";
import { encryptCredentials, decryptCredentials } from "../auth/crypto.js";

export interface TradeRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  clobCredentials: ClobCredentialStore;
  orderIntents: OrderIntentStore;
  runtimeFlags: RuntimeFlagStore;
  tradingClobClient: AuthenticatedClobClient;
  geoblockClient: GeoblockClient;
  // Server-side signing (FEATURE_PRIVY_SIGNING). Used only on the Privy path; the
  // legacy browser-signed path ignores these.
  tradingSigner: TradingSigner;
  privyWallets: PrivyWalletStore;
  delegations: DelegationStore;
}

const TICK_SIZES: readonly TickSize[] = ["0.1", "0.01", "0.001", "0.0001"];
const isTickSize = (v: unknown): v is TickSize => TICK_SIZES.includes(v as TickSize);

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

const getDecryptedCreds = async (
  deps: TradeRoutesDeps,
  walletAddress: string,
  reply: FastifyReply,
): Promise<L2Credentials | null> => {
  const row = await deps.clobCredentials.find(walletAddress);
  if (!row) {
    reply.code(400);
    await reply.send({
      error: "CLOB_CREDENTIALS_NOT_SET",
      message: "CLOB API credentials not set up. Call POST /api/trade/credentials/setup first.",
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

export const registerTradeRoutes = (app: FastifyInstance, deps: TradeRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });
  // TODO(geoblock): TEMPORARILY DISABLED for local testing — restore this and the
  // `geoblockCheck` preHandlers below (plus the makeGeoblockCheck import) before any staging/live use.
  // const geoblockCheck = makeGeoblockCheck({
  //   geoblockClient: deps.geoblockClient,
  //   auditStore: deps.auditStore,
  // });

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
      signingAddress = clobSignerAddress(user.walletAddress);
      l1Signature = bodySig;
      timestamp = ts;
      nonce = nc;
    } else if (deps.config.features.privySigning) {
      const wallet = await deps.privyWallets.find(user.walletAddress);
      if (!wallet) {
        reply.code(400);
        return {
          error: "TRADING_WALLET_NOT_PROVISIONED",
          message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
        };
      }
      const timeResult = await deps.tradingClobClient.getServerTime();
      if (!timeResult.ok) {
        reply.code(502);
        return { error: "CLOB_TIME_FAILED", message: timeResult.error.message };
      }
      signingAddress = clobSignerAddress(wallet.embeddedAddress);
      timestamp = String(timeResult.value);
      nonce = "0";
      const typedData = buildClobAuthTypedData(
        signingAddress,
        deps.config.polymarket.chainId,
        timestamp,
        0,
      );
      const signed = await deps.tradingSigner.signClobAuth({
        wallet: { walletId: wallet.privyWalletId, address: wallet.embeddedAddress },
        typedData,
      });
      if (!signed.ok) {
        reply.code(502);
        return { error: "CLOB_SIGN_FAILED", message: signed.error.message };
      }
      l1Signature = signed.value.signature;
    } else {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "l1Signature, timestamp, and nonce required" };
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
    await deps.clobCredentials.upsert(user.walletAddress, encrypted);
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trade.credentials.setup" as const,
      subject: `wallet:${user.walletAddress}`,
      metadata: { apiKey: result.value.apiKey },
    });

    return { ok: true, apiKey: result.value.apiKey };
  });

  // ── GET /api/trade/account ─────────────────────────────────────────────────
  // Authenticated + trading enabled + geoblock check.
  app.get(
    "/api/trade/account",
    // TODO(geoblock): TEMPORARILY DISABLED for local testing — restore [requireAuth, geoblockCheck] before any staging/live use.
    { preHandler: [requireAuth /*, geoblockCheck */] },
    async (req, reply) => {
      if (!(await assertTradingEnabled(deps, reply))) return;
      const user = req.user!;
      const creds = await getDecryptedCreds(deps, user.walletAddress, reply);
      if (!creds) return;
      const signer = clobSignerAddress(user.walletAddress);

      const balResult = await deps.tradingClobClient.getBalanceAllowance(signer, creds);
      const ordersResult = await deps.tradingClobClient.getOpenOrders(signer, creds);

      return {
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
    // TODO(geoblock): TEMPORARILY DISABLED for local testing — restore [requireAuth, geoblockCheck] before any staging/live use.
    { preHandler: [requireAuth /*, geoblockCheck */] },
    async (req, reply) => {
      const user = req.user!;
      const body = req.body as Record<string, unknown>;

      const conditionId = typeof body["conditionId"] === "string" ? body["conditionId"] : null;
      const tokenId = typeof body["tokenId"] === "string" ? body["tokenId"] : null;
      const side = body["side"] === "BUY" || body["side"] === "SELL" ? body["side"] : null;
      const price = typeof body["price"] === "string" ? body["price"] : null;
      const size = typeof body["size"] === "string" ? body["size"] : null;
      const orderType = ["GTC", "GTD", "FOK"].includes(body["orderType"] as string)
        ? (body["orderType"] as string)
        : "GTC";
      const funder = typeof body["funder"] === "string" ? body["funder"] : null;

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
        subject: `market:${conditionId}`,
        metadata: { tokenId, side, price, size, orderType, funder },
      });

      return {
        conditionId,
        tokenId,
        side,
        price,
        size,
        orderType,
        funder,
        maxSpend,
        builderCode: deps.config.polymarket.builderCode ?? null,
        signatureType: deps.config.features.privySigning ? 0 : 2,
        timestamp,
        note: deps.config.features.privySigning
          ? "Server-side signing is enabled: POST /api/trade/orders with {tokenId, side, price, size} and the server signs with your Privy trading wallet (signatureType 0). No wallet popup."
          : "Build + sign the CTF Exchange order with your EOA (signatureType 2, POLY_GNOSIS_SAFE; maker = your deposit wallet). Send the signed order to POST /api/trade/orders.",
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
    // TODO(geoblock): TEMPORARILY DISABLED for local testing — restore [requireAuth, geoblockCheck] before any staging/live use.
    { preHandler: [requireAuth /*, geoblockCheck */] },
    async (req, reply) => {
      if (!(await assertTradingEnabled(deps, reply))) return;
      const user = req.user!;
      const body = req.body as Record<string, unknown>;

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

      // Obtain a signed CLOB order. Two modes:
      //  - Privy path (FEATURE_PRIVY_SIGNING): the server builds + signs the order
      //    (signatureType 0) with the user's delegated Privy wallet — no popup.
      //  - Legacy path: the client posts a fully-signed `order` we forward verbatim.
      let signedOrder: SignedClobOrder;
      let tokenId: string;
      let side: "BUY" | "SELL";
      let funder: string;
      let clobAddress: `0x${string}`;

      if (deps.config.features.privySigning) {
        const tokenIdIn = typeof body["tokenId"] === "string" ? body["tokenId"] : null;
        const sideIn = body["side"] === "BUY" || body["side"] === "SELL" ? body["side"] : null;
        if (!tokenIdIn || !sideIn) {
          reply.code(400);
          return {
            error: "INVALID_REQUEST",
            message: "tokenId and side are required for server-side signing",
          };
        }
        const negRisk = body["negRisk"] === true;
        const tickSize = isTickSize(body["tickSize"]) ? body["tickSize"] : undefined;

        const wallet = await deps.privyWallets.find(user.walletAddress);
        if (!wallet) {
          reply.code(400);
          return {
            error: "TRADING_WALLET_NOT_PROVISIONED",
            message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
          };
        }
        // Session-expiry guardrail: signing requires an active, unexpired delegation.
        const delegation = await deps.delegations.findActive(user.walletAddress);
        if (!delegation) {
          reply.code(401);
          return {
            error: "DELEGATION_EXPIRED",
            message: "Trading authorization has expired. Re-authorize to continue.",
          };
        }
        // Fail-closed: never submit before required on-chain allowances are set.
        if (!wallet.allowancesBootstrappedAt) {
          reply.code(400);
          return {
            error: "ALLOWANCES_NOT_BOOTSTRAPPED",
            message:
              "Trading wallet allowances are not set up. Call POST /api/trading-wallet/bootstrap-allowances.",
          };
        }

        const built = await buildAndSignEoaOrder(
          {
            tokenId: tokenIdIn,
            side: sideIn,
            price,
            size,
            address: wallet.embeddedAddress,
            chainId: deps.config.polymarket.chainId,
            negRisk,
            ...(tickSize !== undefined ? { tickSize } : {}),
            builderCode: deps.config.polymarket.builderCode ?? null,
          },
          (typedData) =>
            deps.tradingSigner.signOrder({
              wallet: { walletId: wallet.privyWalletId, address: wallet.embeddedAddress },
              typedData,
            }),
        );
        if (!built.ok) {
          await deps.auditStore.emit({
            actor: user.walletAddress,
            action: "order.failed",
            subject: `idem:${idempotencyKey}`,
            metadata: { error: built.error.code, message: built.error.message },
          });
          reply.code(502);
          return { error: "ORDER_SIGN_FAILED", message: built.error.message };
        }
        signedOrder = built.value;
        tokenId = tokenIdIn;
        side = sideIn;
        funder = wallet.embeddedAddress;
        clobAddress = clobSignerAddress(wallet.embeddedAddress);
        await deps.auditStore.emit({
          actor: user.walletAddress,
          action: "order.signed",
          subject: `idem:${idempotencyKey}`,
          metadata: { tokenId, side, signatureType: 0, signer: wallet.embeddedAddress },
        });
      } else {
        // Legacy: the client builds + signs the CLOB order struct (EIP-712 over the CTF
        // Exchange domain). We validate its shape and forward it verbatim — its
        // signature commits to every field, so we must not mutate it.
        const parsedOrder = SignedClobOrderSchema.safeParse(body["order"]);
        if (!parsedOrder.success) {
          reply.code(400);
          return { error: "INVALID_REQUEST", message: "a signed `order` struct is required" };
        }
        signedOrder = parsedOrder.data;
        tokenId = signedOrder.tokenId;
        side = signedOrder.side === "BUY" || signedOrder.side === 0 ? "BUY" : "SELL";
        funder = signedOrder.maker;
        clobAddress = clobSignerAddress(user.walletAddress);
      }

      const creds = await getDecryptedCreds(deps, user.walletAddress, reply);
      if (!creds) return;

      // Create the intent record before submission so failures are audited.
      const intent = await deps.orderIntents.create({
        walletAddress: user.walletAddress,
        idempotencyKey,
        conditionId,
        tokenId,
        side,
        price,
        size,
        orderType,
        funder,
        metadata: { builderCode: deps.config.polymarket.builderCode },
      });

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "order.intent",
        subject: `intent:${intent.id}`,
        metadata: { conditionId, tokenId, side, price, size, orderType, funder },
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
        metadata: { clobOrderId, status: submitResult.value.status },
      });

      reply.code(201);
      return { intentId: intent.id, clobOrderId, status: "submitted" };
    },
  );

  // ── DELETE /api/trade/orders/:id ──────────────────────────────────────────
  // Authenticated + trading enabled + geoblock.
  app.delete(
    "/api/trade/orders/:id",
    // TODO(geoblock): TEMPORARILY DISABLED for local testing — restore [requireAuth, geoblockCheck] before any staging/live use.
    { preHandler: [requireAuth /*, geoblockCheck */] },
    async (req, reply) => {
      if (!(await assertTradingEnabled(deps, reply))) return;
      const user = req.user!;
      const params = req.params as { id: string };
      const clobOrderId = params.id;

      if (!clobOrderId) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "order id required in path" };
      }

      const creds = await getDecryptedCreds(deps, user.walletAddress, reply);
      if (!creds) return;

      const result = await deps.tradingClobClient.cancelOrder(
        clobOrderId,
        creds,
        clobSignerAddress(user.walletAddress),
      );

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: result.ok ? "order.cancelled" : "order.cancel_failed",
        subject: `clob_order:${clobOrderId}`,
        metadata: { ok: result.ok, error: result.ok ? null : result.error.code },
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
