import type { Result } from "@mx2/core";
import { err, ok } from "@mx2/core";
import {
  BridgeDepositResponseSchema,
  BridgeQuoteResponseSchema,
  BridgeStatusResponseSchema,
  BridgeSupportedAssetsResponseSchema,
  BridgeWithdrawResponseSchema,
  type BridgeDepositAddresses,
  type BridgeQuoteResponse,
  type BridgeStatusResponse,
  type BridgeSupportedAssetsResponse,
} from "./schema.js";
import {
  networkError,
  parseError,
  rateLimitError,
  timeoutError,
  upstreamError,
  type PolymarketError,
} from "../errors.js";

export interface CreateBridgeDepositAddressesParams {
  /** Polymarket deposit/proxy wallet that will receive pUSD on Polygon. */
  polymarketWalletAddress: string;
}

export interface BridgeQuoteParams {
  fromAmountBaseUnit: string;
  fromChainId: string;
  fromTokenAddress: string;
  recipientAddress: string;
  toChainId: string;
  toTokenAddress: string;
}

export interface CreateBridgeWithdrawalAddressesParams {
  /** Polymarket deposit/proxy wallet the funds leave from (Polygon). */
  polymarketWalletAddress: string;
  toChainId: string;
  toTokenAddress: string;
  /** Final recipient on the destination chain (the user's own login wallet). */
  recipientAddr: string;
}

export interface BridgeClient {
  getSupportedAssets(): Promise<Result<BridgeSupportedAssetsResponse, PolymarketError>>;
  createDepositAddresses(
    params: CreateBridgeDepositAddressesParams,
  ): Promise<Result<BridgeDepositAddresses, PolymarketError>>;
  /** Fee/ETA/min-received estimate for a route (both directions). */
  getQuote(params: BridgeQuoteParams): Promise<Result<BridgeQuoteResponse, PolymarketError>>;
  /**
   * Withdrawal is address-based like deposits: the returned bridge address is
   * the Polygon hop — send pUSD/USDC.e there and the bridge delivers
   * toTokenAddress to recipientAddr on toChainId.
   */
  createWithdrawalAddresses(
    params: CreateBridgeWithdrawalAddressesParams,
  ): Promise<Result<BridgeDepositAddresses, PolymarketError>>;
  /** Transfer statuses for a generated bridge address (deposit or withdrawal). */
  getStatus(bridgeAddress: string): Promise<Result<BridgeStatusResponse, PolymarketError>>;
}

export interface BridgeClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Optional public builder attribution. Sent only when valid bytes32 hex. */
  builderCode?: string | undefined;
}

type SafeParser<T> = {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
};

const DEFAULT_BASE_URL = "https://bridge.polymarket.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const BUILDER_CODE_RE = /^0x[0-9a-fA-F]{64}$/;

const buildUrl = (base: string, path: string): string => new URL(path, base).toString();

const fetchJson = async <T>(
  url: string,
  init: RequestInit | undefined,
  schema: SafeParser<T>,
  timeoutMs: number,
): Promise<Result<T, PolymarketError>> => {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      if (response.status === 429) return err(rateLimitError());
      return err(upstreamError(response.status, `bridge HTTP ${response.status}`));
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

export const createBridgeClient = (opts?: BridgeClientOptions): BridgeClient => {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const builderCode =
    opts?.builderCode && BUILDER_CODE_RE.test(opts.builderCode) ? opts.builderCode : undefined;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (builderCode) headers["X-Builder-Code"] = builderCode;

  return {
    getSupportedAssets: () =>
      fetchJson(
        buildUrl(baseUrl, "/supported-assets"),
        { headers },
        BridgeSupportedAssetsResponseSchema,
        timeoutMs,
      ),

    async createDepositAddresses(params) {
      const result = await fetchJson(
        buildUrl(baseUrl, "/deposit"),
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ polymarketWalletAddress: params.polymarketWalletAddress }),
        },
        BridgeDepositResponseSchema,
        timeoutMs,
      );
      if (!result.ok) return result;
      const addresses = result.value.addresses ?? result.value.depositAddresses;
      if (!addresses) return err(parseError("Bridge deposit response did not include addresses"));
      return ok(addresses);
    },

    getQuote: (params) =>
      fetchJson(
        buildUrl(baseUrl, "/quote"),
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        BridgeQuoteResponseSchema,
        timeoutMs,
      ),

    async createWithdrawalAddresses(params) {
      const result = await fetchJson(
        buildUrl(baseUrl, "/withdraw"),
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            address: params.polymarketWalletAddress,
            toChainId: params.toChainId,
            toTokenAddress: params.toTokenAddress,
            recipientAddr: params.recipientAddr,
          }),
        },
        BridgeWithdrawResponseSchema,
        timeoutMs,
      );
      if (!result.ok) return result;
      const addresses = result.value.address ?? result.value.addresses;
      if (!addresses) return err(parseError("Bridge withdraw response did not include addresses"));
      return ok(addresses);
    },

    getStatus: (bridgeAddress) =>
      fetchJson(
        buildUrl(baseUrl, `/status/${encodeURIComponent(bridgeAddress)}`),
        { headers },
        BridgeStatusResponseSchema,
        timeoutMs,
      ),
  };
};
