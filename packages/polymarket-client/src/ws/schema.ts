import { z } from "zod";

const OrderLevelSchema = z.object({ price: z.string(), size: z.string() }).passthrough();

export const WsBookMessageSchema = z
  .object({
    event_type: z.literal("book"),
    asset_id: z.string(),
    market: z.string(),
    buys: z.array(OrderLevelSchema),
    sells: z.array(OrderLevelSchema),
    hash: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

export const WsPriceChangeMessageSchema = z
  .object({
    event_type: z.literal("price_change"),
    asset_id: z.string(),
    market: z.string(),
    price: z.string(),
    timestamp: z.string(),
  })
  .passthrough();

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
    tick_size: z.string(),
    timestamp: z.string(),
  })
  .passthrough();

export const WsMarketMessageSchema = z.discriminatedUnion("event_type", [
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
