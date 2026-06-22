export type PolymarketErrorCode =
  | "NETWORK_ERROR"
  | "UPSTREAM_ERROR"
  | "PARSE_ERROR"
  | "RATE_LIMIT"
  | "TIMEOUT";

export interface PolymarketError {
  readonly code: PolymarketErrorCode;
  readonly message: string;
  readonly statusCode?: number;
  readonly cause?: unknown;
}

export const networkError = (message: string, cause?: unknown): PolymarketError => {
  if (cause !== undefined) return { code: "NETWORK_ERROR", message, cause };
  return { code: "NETWORK_ERROR", message };
};

export const upstreamError = (statusCode: number, message: string): PolymarketError => ({
  code: "UPSTREAM_ERROR",
  message,
  statusCode,
});

export const parseError = (message: string, cause?: unknown): PolymarketError => {
  if (cause !== undefined) return { code: "PARSE_ERROR", message, cause };
  return { code: "PARSE_ERROR", message };
};

export const timeoutError = (): PolymarketError => ({
  code: "TIMEOUT",
  message: "Request timed out",
});

export const rateLimitError = (): PolymarketError => ({
  code: "RATE_LIMIT",
  message: "Rate limit exceeded",
  statusCode: 429,
});
