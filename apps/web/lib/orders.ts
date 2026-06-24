import type { OrderPreviewRequest, OrderSide, OrderType } from "./types";

export interface PreviewInput {
  conditionId: string;
  tokenId: string | undefined;
  side: OrderSide;
  price: string;
  size: string;
  orderType?: OrderType;
  funder: string;
}

export type PreviewBuildResult =
  | { ok: true; request: OrderPreviewRequest }
  | { ok: false; error: string };

// Client-side validation that mirrors the backend's rules in
// apps/api/src/routes/trade.ts (price in (0,1), positive size, required ids).
// Building this here gives instant feedback and keeps the request shape correct.
export function buildPreviewRequest(input: PreviewInput): PreviewBuildResult {
  if (!input.conditionId || !input.tokenId) {
    return { ok: false, error: "Missing market identifiers." };
  }
  if (!input.funder) {
    return { ok: false, error: "Connect a wallet to set the funder address." };
  }
  const price = parseFloat(input.price);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { ok: false, error: "Price must be between 0 and 1 (exclusive)." };
  }
  const size = parseFloat(input.size);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: "Size must be a positive number." };
  }
  return {
    ok: true,
    request: {
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      side: input.side,
      price: input.price,
      size: input.size,
      orderType: input.orderType ?? "GTC",
      funder: input.funder,
    },
  };
}
