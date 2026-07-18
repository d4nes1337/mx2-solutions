import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import {
  L2CredentialsSchema,
  BalanceAllowanceSchema,
  OpenOrdersResponseSchema,
  SubmitOrderResponseSchema,
  UserTradesResponseSchema,
  type L2Credentials,
  type BalanceAllowance,
  type OpenOrder,
  type SubmitOrderResponse,
  type SignedClobOrder,
  type OrderType,
  type UserTrade,
} from "./schema.js";
import { buildL2Headers, type L2HeaderArgs } from "./hmac.js";
import {
  networkError,
  upstreamError,
  parseError,
  timeoutError,
  rateLimitError,
  type PolymarketError,
} from "../errors.js";

export interface DeriveApiKeyParams {
  address: string;
  l1Signature: string;
  timestamp: string;
  nonce: string;
}

export interface AuthenticatedClobClient {
  /** Polymarket CLOB server unix timestamp (seconds). Required for L1 auth signing. */
  getServerTime(): Promise<Result<number, PolymarketError>>;
  deriveApiKey(params: DeriveApiKeyParams): Promise<Result<L2Credentials, PolymarketError>>;
  getBalanceAllowance(
    address: string,
    creds: L2Credentials,
  ): Promise<Result<BalanceAllowance, PolymarketError>>;
  submitOrder(
    order: SignedClobOrder,
    orderType: OrderType,
    creds: L2Credentials,
    address: string,
    idempotencyKey: string,
    opts?: SubmitOrderOptions,
  ): Promise<Result<SubmitOrderResponse, PolymarketError>>;
  cancelOrder(
    clobOrderId: string,
    creds: L2Credentials,
    address: string,
  ): Promise<Result<void, PolymarketError>>;
  getOpenOrders(
    address: string,
    creds: L2Credentials,
  ): Promise<Result<OpenOrder[], PolymarketError>>;
  /**
   * The caller's own trades (fills) — GET /data/trades, paginated. Used by the
   * order-sync loop to distinguish "filled" from "cancelled" once an order
   * leaves the open-orders set.
   */
  getUserTrades(
    address: string,
    creds: L2Credentials,
    params?: UserTradeParams,
  ): Promise<Result<UserTrade[], PolymarketError>>;
}

export interface UserTradeParams {
  asset_id?: string;
  market?: string;
  before?: string;
  after?: string;
}

export interface SubmitOrderOptions {
  /**
   * Maker-only: the CLOB rejects the order instead of crossing (GTC/GTD only;
   * INVALID_POST_ONLY_ORDER_TYPE with FOK/FAK). Default false.
   */
  postOnly?: boolean;
}

export interface AuthenticatedClobClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://clob.polymarket.com";
const DEFAULT_TIMEOUT_MS = 15_000;
/** First-page cursor for GET /data/orders (matches @polymarket/clob-client INITIAL_CURSOR). */
const INITIAL_CURSOR = "MA==";

const buildL1Headers = (params: DeriveApiKeyParams): Record<string, string> => ({
  POLY_ADDRESS: params.address,
  POLY_SIGNATURE: params.l1Signature,
  POLY_TIMESTAMP: params.timestamp,
  POLY_NONCE: params.nonce,
});

const doFetch = async <T>(
  url: string,
  opts: RequestInit,
  schema: {
    safeParse(
      d: unknown,
    ): { success: true; data: T } | { success: false; error: { message: string } };
  },
  timeoutMs: number,
): Promise<Result<T, PolymarketError>> => {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...opts, signal: controller.signal });
    if (!response.ok) {
      if (response.status === 429) return err(rateLimitError());
      const body = await response.text().catch(() => "");
      return err(upstreamError(response.status, `HTTP ${response.status}: ${body}`));
    }
    const json: unknown = await response.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) return err(parseError(parsed.error.message));
    return ok(parsed.data);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return err(timeoutError());
    return err(networkError(e instanceof Error ? e.message : String(e), e));
  } finally {
    clearTimeout(timerId);
  }
};

export const createAuthenticatedClobClient = (
  opts?: AuthenticatedClobClientOptions,
): AuthenticatedClobClient => {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const getServerTime = async (): Promise<Result<number, PolymarketError>> => {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/time`, { signal: controller.signal });
      if (!response.ok) {
        return err(
          upstreamError(response.status, `HTTP ${response.status}: failed to fetch CLOB time`),
        );
      }
      const text = (await response.text()).trim();
      const ts = Number.parseInt(text, 10);
      if (!Number.isFinite(ts)) return err(parseError(`Invalid CLOB /time response: ${text}`));
      return ok(ts);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return err(timeoutError());
      return err(networkError(e instanceof Error ? e.message : String(e), e));
    } finally {
      clearTimeout(timerId);
    }
  };

  const l2Headers = async (
    address: string,
    creds: L2Credentials,
    args: L2HeaderArgs,
  ): Promise<Result<Record<string, string>, PolymarketError>> => {
    const tsResult = await getServerTime();
    if (!tsResult.ok) return err(tsResult.error);
    return ok(buildL2Headers(address, creds, tsResult.value, args));
  };

  return {
    getServerTime,

    async deriveApiKey(params) {
      // create-or-derive (mirrors @polymarket/clob-client createOrDeriveApiKey):
      // POST /auth/api-key creates a new L2 key; if one already exists for this
      // signer it errors, so we fall back to the deterministic GET /auth/derive-api-key.
      // Both use the same L1 (ClobAuth) headers.
      const headers = {
        ...buildL1Headers(params),
        "Content-Type": "application/json",
      };
      const created = await doFetch(
        `${baseUrl}/auth/api-key`,
        { method: "POST", headers },
        L2CredentialsSchema,
        timeoutMs,
      );
      if (created.ok) return created;
      // Auth/header failures won't succeed on derive either; surface the first error.
      if (created.error.code === "UPSTREAM_ERROR" && created.error.statusCode === 401) {
        return created;
      }
      return doFetch(
        `${baseUrl}/auth/derive-api-key`,
        { method: "GET", headers },
        L2CredentialsSchema,
        timeoutMs,
      );
    },

    async getBalanceAllowance(address, creds) {
      const requestPath = "/balance-allowance";
      const headersResult = await l2Headers(address, creds, { method: "GET", requestPath });
      if (!headersResult.ok) return err(headersResult.error);
      return doFetch(
        `${baseUrl}${requestPath}?asset_type=CONDITIONAL&token_id=`,
        {
          method: "GET",
          headers: headersResult.value,
        },
        BalanceAllowanceSchema,
        timeoutMs,
      );
    },

    async submitOrder(order, orderType, creds, address, idempotencyKey, opts) {
      // CLOB V2 POST /order body (orderToJsonV2): side is "BUY"|"SELL", includes
      // timestamp/metadata/builder; domain version "2" at sign time.
      const sideWire = order.side === 0 || order.side === "BUY" ? "BUY" : "SELL";
      const requestPath = "/order";
      const body = {
        deferExec: false,
        postOnly: opts?.postOnly ?? false,
        order: {
          salt: typeof order.salt === "string" ? Number.parseInt(order.salt, 10) : order.salt,
          maker: order.maker,
          signer: order.signer,
          tokenId: order.tokenId,
          makerAmount: order.makerAmount,
          takerAmount: order.takerAmount,
          side: sideWire,
          signatureType: order.signatureType,
          timestamp: order.timestamp,
          expiration: order.expiration ?? "0",
          metadata: order.metadata,
          builder: order.builder,
          signature: order.signature,
        },
        owner: creds.apiKey,
        orderType,
      };
      const bodyStr = JSON.stringify(body);
      const headersResult = await l2Headers(address, creds, {
        method: "POST",
        requestPath,
        body: bodyStr,
      });
      if (!headersResult.ok) return err(headersResult.error);
      return doFetch(
        `${baseUrl}${requestPath}`,
        {
          method: "POST",
          headers: {
            ...headersResult.value,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: bodyStr,
        },
        SubmitOrderResponseSchema,
        timeoutMs,
      );
    },

    async cancelOrder(clobOrderId, creds, address) {
      const requestPath = "/order";
      const bodyStr = JSON.stringify({ orderID: clobOrderId });
      const headersResult = await l2Headers(address, creds, {
        method: "DELETE",
        requestPath,
        body: bodyStr,
      });
      if (!headersResult.ok) return err(headersResult.error);
      const result = await doFetch(
        `${baseUrl}${requestPath}`,
        {
          method: "DELETE",
          headers: {
            ...headersResult.value,
            "Content-Type": "application/json",
          },
          body: bodyStr,
        },
        // Accept any object shape for cancel response
        { safeParse: (d: unknown) => ({ success: true as const, data: d as object }) },
        timeoutMs,
      );
      if (!result.ok) return err(result.error);
      return ok(undefined);
    },

    async getOpenOrders(address, creds) {
      const requestPath = "/data/orders";
      const headersResult = await l2Headers(address, creds, { method: "GET", requestPath });
      if (!headersResult.ok) return err(headersResult.error);
      const result = await doFetch(
        `${baseUrl}${requestPath}?next_cursor=${INITIAL_CURSOR}`,
        {
          method: "GET",
          headers: headersResult.value,
        },
        OpenOrdersResponseSchema,
        timeoutMs,
      );
      if (!result.ok) return err(result.error);
      return ok(result.value.data);
    },

    async getUserTrades(address, creds, params) {
      // L2 HMAC signs the request path only (query appended after) — mirrors
      // getOpenOrders and @polymarket/clob-client's getTrades pagination:
      // response {data, next_cursor}, END cursor "LTE=".
      const requestPath = "/data/trades";
      const headersResult = await l2Headers(address, creds, { method: "GET", requestPath });
      if (!headersResult.ok) return err(headersResult.error);
      const trades: UserTrade[] = [];
      let cursor = INITIAL_CURSOR;
      const MAX_PAGES = 5;
      for (let page = 0; page < MAX_PAGES && cursor !== "LTE="; page++) {
        const query = new URLSearchParams({ next_cursor: cursor });
        if (params?.asset_id) query.set("asset_id", params.asset_id);
        if (params?.market) query.set("market", params.market);
        if (params?.before) query.set("before", params.before);
        if (params?.after) query.set("after", params.after);
        const result = await doFetch(
          `${baseUrl}${requestPath}?${query.toString()}`,
          {
            method: "GET",
            headers: headersResult.value,
          },
          UserTradesResponseSchema,
          timeoutMs,
        );
        if (!result.ok) return err(result.error);
        trades.push(...result.value.data);
        cursor = result.value.next_cursor;
      }
      return ok(trades);
    },
  };
};
