import { z } from "zod";

const OrderLevelSchema = z.object({ price: z.string(), size: z.string() }).passthrough();

/**
 * Market-channel message shapes. Upstream renamed/reshaped these on
 * 2025-09-15 (verified against docs.polymarket.com + production WS clients):
 *   - `book` levels renamed `buys`/`sells` → `bids`/`asks`,
 *   - `price_change` went from one flat change per message to a batched
 *     `price_changes` array with per-item `asset_id`.
 * Both generations are accepted here (fixtures/replays may carry the legacy
 * shape) and normalized by the accessors below — consumers must never read
 * the raw side/change fields directly.
 */
export const WsBookMessageSchema = z
  .object({
    event_type: z.literal("book"),
    asset_id: z.string(),
    market: z.string(),
    buys: z.array(OrderLevelSchema).optional(),
    sells: z.array(OrderLevelSchema).optional(),
    bids: z.array(OrderLevelSchema).optional(),
    asks: z.array(OrderLevelSchema).optional(),
    hash: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough()
  .refine(
    (m) =>
      (m.buys !== undefined && m.sells !== undefined) ||
      (m.bids !== undefined && m.asks !== undefined),
    { message: "book message must carry buys/sells or bids/asks" },
  );

/** Both sides of a book message, whichever generation of field names it used. */
export const bookSides = (
  msg: WsBookMessage,
): { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] } => ({
  bids: msg.bids ?? msg.buys ?? [],
  asks: msg.asks ?? msg.sells ?? [],
});

const PriceChangeEntrySchema = z
  .object({
    asset_id: z.string(),
    price: z.string(),
    size: z.string().optional(),
    side: z.string().optional(),
    hash: z.string().optional(),
    best_bid: z.string().optional(),
    best_ask: z.string().optional(),
  })
  .passthrough();

export const WsPriceChangeMessageSchema = z
  .object({
    event_type: z.literal("price_change"),
    market: z.string().optional(),
    timestamp: z.string(),
    // Current (2025-09+) batched shape:
    price_changes: z.array(PriceChangeEntrySchema).optional(),
    // Legacy flat shape (one change per message):
    asset_id: z.string().optional(),
    price: z.string().optional(),
    size: z.string().optional(),
    side: z.string().optional(),
  })
  .passthrough()
  .refine(
    (m) => m.price_changes !== undefined || (m.asset_id !== undefined && m.price !== undefined),
    {
      message: "price_change message must carry price_changes[] or asset_id+price",
    },
  );

/** One normalized orderbook level change from a price_change message. */
export interface PriceChangeItem {
  assetId: string;
  /** The level's price (NOT a trade print). */
  price: string;
  size?: string | undefined;
  /** "BUY" (bid side) or "SELL" (ask side) when upstream provides it. */
  side?: string | undefined;
  bestBid?: string | undefined;
  bestAsk?: string | undefined;
}

/** Normalize either price_change generation into per-token level changes. */
export const priceChangeItems = (msg: WsPriceChangeMessage): PriceChangeItem[] => {
  if (msg.price_changes !== undefined) {
    return msg.price_changes.map((c) => ({
      assetId: c.asset_id,
      price: c.price,
      size: c.size,
      side: c.side,
      bestBid: c.best_bid,
      bestAsk: c.best_ask,
    }));
  }
  if (msg.asset_id !== undefined && msg.price !== undefined) {
    return [{ assetId: msg.asset_id, price: msg.price, size: msg.size, side: msg.side }];
  }
  return [];
};

export const WsLastTradePriceMessageSchema = z
  .object({
    event_type: z.literal("last_trade_price"),
    asset_id: z.string(),
    market: z.string(),
    price: z.string(),
    timestamp: z.string(),
  })
  .passthrough();

export const WsTickSizeChangeMessageSchema = z
  .object({
    event_type: z.literal("tick_size_change"),
    asset_id: z.string(),
    market: z.string(),
    tick_size: z.string().optional(),
    new_tick_size: z.string().optional(),
    old_tick_size: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

// z.union (not discriminatedUnion): the refined book/price_change schemas are
// ZodEffects, which discriminatedUnion cannot host. Each schema still gates on
// its own event_type literal, so matching stays unambiguous.
export const WsMarketMessageSchema = z.union([
  WsBookMessageSchema,
  WsPriceChangeMessageSchema,
  WsLastTradePriceMessageSchema,
  WsTickSizeChangeMessageSchema,
]);

export type WsBookMessage = z.infer<typeof WsBookMessageSchema>;
export type WsPriceChangeMessage = z.infer<typeof WsPriceChangeMessageSchema>;
export type WsLastTradePriceMessage = z.infer<typeof WsLastTradePriceMessageSchema>;
export type WsTickSizeChangeMessage = z.infer<typeof WsTickSizeChangeMessageSchema>;
export type WsMarketMessage = z.infer<typeof WsMarketMessageSchema>;
