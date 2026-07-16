/**
 * Deposit-wallet CLOB session — the POLY_1271 seam (R-009, INTEGRATION §12a).
 *
 * Wraps the official `@polymarket/clob-client-v2` for everything the
 * server-side deposit-wallet identity needs: L1 credential derivation, order
 * create/post (signatureType 3, maker = signer = funder = deposit wallet,
 * ERC-7739-wrapped signature produced by the SDK), cancels, open orders and
 * rewards earnings. The SDK duck-types its signer: anything exposing
 * `account.address` + viem-style `signTypedData` works — which is exactly the
 * shape of the app's Privy typed-data bridge. No raw keys ever touch this
 * module; the injected sign callback is the only signing capability.
 *
 * Everything returns Result — the SDK throws, this adapter maps.
 */
import {
  ClobClient,
  OrderBuilder,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import { networkError, upstreamError, type PolymarketError } from "../errors.js";
import type { TickSize } from "./order-builder.js";

const DEFAULT_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

/** Minimal EIP-712 payload the injected signer receives. */
export interface Eip712Payload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Typed-data-only signing capability (the Privy bridge in production, a local
 * viem account in tests). Must THROW on failure — the adapter maps to Result.
 */
export type SignTypedDataFn = (payload: Eip712Payload) => Promise<string>;

/** Builds the viem-WalletClient duck the SDK accepts (signTypedData only). */
export const makeSdkTypedDataSigner = (signerAddress: string, sign: SignTypedDataFn) => ({
  account: { address: signerAddress },
  signTypedData: (args: {
    account?: unknown;
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) =>
    sign({
      domain: args.domain,
      types: args.types,
      primaryType: args.primaryType,
      message: args.message,
    }),
});

export interface ClobV2OrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  /** Probability price 0..1. */
  price: number;
  /** Size in shares. */
  size: number;
  tickSize: TickSize;
  negRisk: boolean;
  orderType: "GTC" | "GTD" | "FOK" | "FAK";
  /** Resting-only; the CLOB rejects instead of crossing. GTC/GTD only. */
  postOnly?: boolean;
  /** GTD only: unix seconds expiration. */
  expiresAtSec?: number;
}

export interface ClobV2OrderAck {
  orderId: string;
  status: string;
}

export interface OpenOrderLite {
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  originalSize: number;
  sizeMatched: number;
}

export interface RewardsEarningLite {
  conditionId: string;
  earningsUsd: number;
}

export interface ClobV2Session {
  /** The EOA signer address (API-key identity per INTEGRATION §12a). */
  readonly signerAddress: string;
  readonly depositWalletAddress: string;
  /** L1: derive (or create) the L2 API creds for the signer identity. */
  deriveCreds(): Promise<Result<ApiKeyCreds, PolymarketError>>;
  /** Attach L2 creds (returns a NEW session view; the SDK client is rebuilt). */
  withCreds(creds: ApiKeyCreds): ClobV2Session;
  /** Build + sign + submit a POLY_1271 order. Requires creds. */
  placeOrder(params: ClobV2OrderParams): Promise<Result<ClobV2OrderAck, PolymarketError>>;
  cancelOrder(orderId: string): Promise<Result<void, PolymarketError>>;
  /** Open orders for the deposit-wallet identity, optionally per token. */
  getOpenOrders(tokenId?: string): Promise<Result<OpenOrderLite[], PolymarketError>>;
  /** Liquidity-rewards earnings for a UTC day (YYYY-MM-DD). Requires creds. */
  getEarningsForDay(day: string): Promise<Result<RewardsEarningLite[], PolymarketError>>;
}

export interface ClobV2SessionOptions {
  signerAddress: string;
  sign: SignTypedDataFn;
  depositWalletAddress: string;
  creds?: ApiKeyCreds;
  host?: string;
  chainId?: number;
  /** Non-secret builder attribution code, when configured. */
  builderConfig?: { apiKey: string; secret: string; passphrase: string } | undefined;
}

const mapThrown = (e: unknown): PolymarketError => {
  const message = e instanceof Error ? e.message : String(e);
  // The SDK throws plain Errors for HTTP failures with the response text.
  if (/^(4|5)\d\d/.test(message) || /status/i.test(message)) {
    return upstreamError(502, message);
  }
  return networkError(message, e);
};

const toOrderType = (t: ClobV2OrderParams["orderType"]): OrderType => {
  switch (t) {
    case "GTC":
      return OrderType.GTC;
    case "GTD":
      return OrderType.GTD;
    case "FOK":
      return OrderType.FOK;
    case "FAK":
      return OrderType.FAK;
  }
};

/**
 * Offline order build+sign (no HTTP): the SDK's exported OrderBuilder is the
 * exact code path `client.createOrder` delegates to, minus its network
 * tick-size/version lookups (our quoter engine already knows both). Pinned to
 * order VERSION 2 per INTEGRATION §12a; a venue-side version mismatch
 * surfaces as an order rejection at staging.
 */
export const build1271SignedOrder = async (
  opts: Pick<ClobV2SessionOptions, "signerAddress" | "sign" | "depositWalletAddress" | "chainId">,
  params: ClobV2OrderParams,
): Promise<Record<string, unknown>> => {
  const builder = new OrderBuilder(
    makeSdkTypedDataSigner(opts.signerAddress, opts.sign) as never,
    opts.chainId ?? POLYGON_CHAIN_ID,
    SignatureTypeV2.POLY_1271,
    opts.depositWalletAddress,
  );
  const tick = Number(params.tickSize);
  if (!(params.price >= tick && params.price <= 1 - tick)) {
    throw new Error(`invalid price (${params.price}) for tick size ${params.tickSize}`);
  }
  return (await builder.buildOrder(
    {
      tokenID: params.tokenId,
      price: params.price,
      size: params.size,
      side: params.side === "BUY" ? Side.BUY : Side.SELL,
      ...(params.orderType === "GTD" && params.expiresAtSec !== undefined
        ? { expiration: String(params.expiresAtSec) }
        : {}),
    } as never,
    { tickSize: params.tickSize, negRisk: params.negRisk },
    2,
  )) as unknown as Record<string, unknown>;
};

export const createClobV2Session = (opts: ClobV2SessionOptions): ClobV2Session => {
  const host = opts.host ?? DEFAULT_HOST;
  const chainId = opts.chainId ?? POLYGON_CHAIN_ID;
  const signer = makeSdkTypedDataSigner(opts.signerAddress, opts.sign);

  const client = new ClobClient({
    host,
    chain: chainId,
    signer: signer as never,
    ...(opts.creds ? { creds: opts.creds } : {}),
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: opts.depositWalletAddress,
    useServerTime: true,
    throwOnError: true,
  } as never);

  return {
    signerAddress: opts.signerAddress,
    depositWalletAddress: opts.depositWalletAddress,

    async deriveCreds() {
      try {
        const creds = await client.createOrDeriveApiKey();
        if (!creds.key) return err(upstreamError(502, "CLOB returned empty API key"));
        return ok(creds);
      } catch (e) {
        return err(mapThrown(e));
      }
    },

    withCreds(creds) {
      return createClobV2Session({ ...opts, creds });
    },

    async placeOrder(params) {
      try {
        const signed = await build1271SignedOrder(opts, params);
        const res = (await client.postOrder(
          signed as never,
          toOrderType(params.orderType),
          params.postOnly ?? false,
        )) as { success?: boolean; orderID?: string; status?: string; errorMsg?: string };
        if (res && res.success === false) {
          return err(upstreamError(502, res.errorMsg ?? "order rejected"));
        }
        return ok({ orderId: res?.orderID ?? "", status: res?.status ?? "live" });
      } catch (e) {
        return err(mapThrown(e));
      }
    },

    async cancelOrder(orderId) {
      try {
        await client.cancelOrder({ orderID: orderId });
        return ok(undefined);
      } catch (e) {
        return err(mapThrown(e));
      }
    },

    async getOpenOrders(tokenId) {
      try {
        const res = await client.getOpenOrders(tokenId ? { asset_id: tokenId } : undefined, true);
        const rows = Array.isArray(res) ? res : ((res as { data?: unknown[] }).data ?? []);
        const orders: OpenOrderLite[] = [];
        for (const raw of rows as Array<Record<string, unknown>>) {
          const orderId = String(raw["id"] ?? "");
          if (orderId === "") continue;
          orders.push({
            orderId,
            tokenId: String(raw["asset_id"] ?? ""),
            side: String(raw["side"] ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
            price: Number(raw["price"] ?? 0),
            originalSize: Number(raw["original_size"] ?? 0),
            sizeMatched: Number(raw["size_matched"] ?? 0),
          });
        }
        return ok(orders);
      } catch (e) {
        return err(mapThrown(e));
      }
    },

    async getEarningsForDay(day) {
      try {
        const rows = await client.getEarningsForUserForDay(day);
        return ok(
          (rows ?? []).map((r) => ({
            conditionId: String(r.condition_id ?? ""),
            earningsUsd: Number(r.earnings ?? 0),
          })),
        );
      } catch (e) {
        return err(mapThrown(e));
      }
    },
  };
};
