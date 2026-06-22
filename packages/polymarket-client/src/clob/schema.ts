import { z } from "zod";

export const OrderLevelSchema = z.object({ price: z.string(), size: z.string() }).passthrough();

export const OrderbookSchema = z
  .object({
    market: z.string(),
    asset_id: z.string(),
    bids: z.array(OrderLevelSchema),
    asks: z.array(OrderLevelSchema),
    hash: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export const TradeSchema = z
  .object({
    id: z.string(),
    market: z.string(),
    asset_id: z.string(),
    side: z.enum(["BUY", "SELL"]),
    size: z.string(),
    price: z.string(),
    status: z.string(),
    match_time: z.string(),
    outcome: z.string().optional(),
    transaction_hash: z.string().optional(),
    type: z.string().default("TRADE"),
  })
  .passthrough();

export const TokenPriceSchema = z
  .object({
    token_id: z.string(),
    price: z.string(),
    winner: z.boolean().optional(),
  })
  .passthrough();

export const LastTradePriceSchema = z.object({ price: z.string() }).passthrough();

export type OrderLevel = z.infer<typeof OrderLevelSchema>;
export type Orderbook = z.infer<typeof OrderbookSchema>;
export type Trade = z.infer<typeof TradeSchema>;
export type TokenPrice = z.infer<typeof TokenPriceSchema>;
