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

// ── Authenticated trading schemas ─────────────────────────────────────────────

export const L2CredentialsSchema = z.object({
  apiKey: z.string(),
  secret: z.string(),
  passphrase: z.string(),
});
export type L2Credentials = z.infer<typeof L2CredentialsSchema>;

export const BalanceAllowanceSchema = z
  .object({
    balance: z.string(),
    allowance: z.string(),
  })
  .passthrough();
export type BalanceAllowance = z.infer<typeof BalanceAllowanceSchema>;

export const OpenOrderSchema = z
  .object({
    id: z.string(),
    market: z.string(),
    asset_id: z.string(),
    side: z.enum(["BUY", "SELL"]),
    original_size: z.string(),
    size_matched: z.string().optional().default("0"),
    price: z.string(),
    status: z.string(),
    created_at: z.number().optional(),
    type: z.string().default("LIMIT"),
  })
  .passthrough();
export type OpenOrder = z.infer<typeof OpenOrderSchema>;

export const OpenOrdersResponseSchema = z
  .object({
    data: z.array(OpenOrderSchema),
    next_cursor: z.string(),
  })
  .passthrough();
export type OpenOrdersResponse = z.infer<typeof OpenOrdersResponseSchema>;

export const SubmitOrderResponseSchema = z
  .object({
    orderID: z.string(),
    status: z.string().optional(),
  })
  .passthrough();
export type SubmitOrderResponse = z.infer<typeof SubmitOrderResponseSchema>;

export type OrderSide = "BUY" | "SELL";
export type OrderType = "GTC" | "GTD" | "FOK" | "FAK";

// Polymarket CLOB SignatureType enum (verified against @polymarket/clob-client
// order-utils; see docs/INTEGRATION_VERIFIED.md §10). EOA=0, POLY_PROXY=1,
// POLY_GNOSIS_SAFE=2. Our deposit wallets are Gnosis Safes → type 2.
export const SIGNATURE_TYPE_POLY_GNOSIS_SAFE = 2 as const;

// CLOB V2 signed order (ExchangeOrderBuilderV2 / orderToJsonV2 wire shape).
export const SignedClobOrderSchema = z
  .object({
    salt: z.union([z.string(), z.number()]),
    maker: z.string(),
    signer: z.string(),
    tokenId: z.string(),
    makerAmount: z.string(),
    takerAmount: z.string(),
    side: z.union([z.enum(["BUY", "SELL"]), z.literal(0), z.literal(1)]),
    signatureType: z.number().int(),
    timestamp: z.string(),
    metadata: z.string(),
    builder: z.string(),
    expiration: z.string().optional(),
    signature: z.string(),
  })
  .passthrough();
export type SignedClobOrder = z.infer<typeof SignedClobOrderSchema>;
