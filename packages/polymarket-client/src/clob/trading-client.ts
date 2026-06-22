import { createHmac } from "crypto";
import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import {
  L2CredentialsSchema,
  BalanceAllowanceSchema,
  OpenOrderSchema,
  SubmitOrderResponseSchema,
  type L2Credentials,
  type BalanceAllowance,
  type OpenOrder,
  type SubmitOrderResponse,
  type SignedOrderPayload,
} from "./schema.js";
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
  deriveApiKey(params: DeriveApiKeyParams): Promise<Result<L2Credentials, PolymarketError>>;
  getBalanceAllowance(
    address: string,
    creds: L2Credentials,
  ): Promise<Result<BalanceAllowance, PolymarketError>>;
  submitOrder(
    order: SignedOrderPayload,
    creds: L2Credentials,
    address: string,
    idempotencyKey: string,
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
}

export interface AuthenticatedClobClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://clob.polymarket.com";
const DEFAULT_TIMEOUT_MS = 15_000;

const buildL2Headers = (address: string, creds: L2Credentials): Record<string, string> => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + address;
  const hmac = createHmac("sha256", Buffer.from(creds.secret, "base64"))
    .update(message)
    .digest("base64");
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: hmac,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
  };
};

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

  return {
    async deriveApiKey(params) {
      return doFetch(
        `${baseUrl}/auth/derive-api-key`,
        {
          method: "GET",
          headers: {
            ...buildL1Headers(params),
            "Content-Type": "application/json",
          },
        },
        L2CredentialsSchema,
        timeoutMs,
      );
    },

    async getBalanceAllowance(address, creds) {
      return doFetch(
        `${baseUrl}/balance-allowance?asset_type=CONDITIONAL&token_id=`,
        {
          method: "GET",
          headers: {
            ...buildL2Headers(address, creds),
          },
        },
        BalanceAllowanceSchema,
        timeoutMs,
      );
    },

    async submitOrder(order, creds, address, idempotencyKey) {
      const body = {
        tokenID: order.tokenId,
        side: order.side,
        price: order.price,
        size: order.size,
        orderType: order.orderType,
        funder: order.funder,
        signature: order.signature,
        signatureType: order.signatureType,
        ...(order.builderCode ? { builderCode: order.builderCode } : {}),
        ...(order.expiration ? { expiration: order.expiration } : {}),
      };
      return doFetch(
        `${baseUrl}/order`,
        {
          method: "POST",
          headers: {
            ...buildL2Headers(address, creds),
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        },
        SubmitOrderResponseSchema,
        timeoutMs,
      );
    },

    async cancelOrder(clobOrderId, creds, address) {
      const result = await doFetch(
        `${baseUrl}/order`,
        {
          method: "DELETE",
          headers: {
            ...buildL2Headers(address, creds),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ orderID: clobOrderId }),
        },
        // Accept any object shape for cancel response
        { safeParse: (d: unknown) => ({ success: true as const, data: d as object }) },
        timeoutMs,
      );
      if (!result.ok) return err(result.error);
      return ok(undefined);
    },

    async getOpenOrders(address, creds) {
      return doFetch(
        `${baseUrl}/orders?status=LIVE`,
        {
          method: "GET",
          headers: buildL2Headers(address, creds),
        },
        OpenOrderSchema.array(),
        timeoutMs,
      );
    },
  };
};
