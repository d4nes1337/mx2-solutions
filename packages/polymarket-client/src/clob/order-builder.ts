import { getAddress, parseUnits } from "viem";
import { ok, type Result } from "@mx2/core";
import type { OrderSide, SignedClobOrder } from "./schema.js";
import { SIGNATURE_TYPE_POLY_GNOSIS_SAFE } from "./schema.js";

// Pure (no I/O) construction of a Polymarket CTF Exchange V2 order + its EIP-712
// typed data. Ported verbatim from the browser implementation (apps/web/lib/order-sign.ts)
// so the server (api + worker) can build the EXACT same bytes a wallet would sign.
// The only addition vs the browser version is that `signatureType` is a parameter:
// EOA (type 0) for server-side Privy signing, POLY_GNOSIS_SAFE (type 2) for the legacy
// browser-signed path. Matches @polymarket/clob-client-v2 (ExchangeOrderBuilderV2 /
// orderToJsonV2). The CLOB defaults to version 2; V1 orders are rejected.

export type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";

interface RoundConfig {
  price: number;
  size: number;
  amount: number;
}

export const ROUNDING_CONFIG: Record<TickSize, RoundConfig> = {
  "0.1": { price: 1, size: 2, amount: 3 },
  "0.01": { price: 2, size: 2, amount: 4 },
  "0.001": { price: 3, size: 2, amount: 5 },
  "0.0001": { price: 4, size: 2, amount: 6 },
};

// CTF Exchange V2 on Polygon (137) — @polymarket/clob-client-v2 MATIC_CONTRACTS.
// V2 orders (domain version "2") must sign against exchangeV2 / negRiskExchangeV2,
// NOT the legacy V1 exchange addresses.
const EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";
const COLLATERAL_DECIMALS = 6;

const PROTOCOL_NAME = "Polymarket CTF Exchange";
/** CLOB V2 exchange domain version (not "1"). */
const PROTOCOL_VERSION = "2";

/** Polymarket CLOB SignatureType for a plain EOA (signer == maker == funder). */
export const SIGNATURE_TYPE_EOA = 0 as const;

export const BYTES32_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const ORDER_STRUCTURE_V2 = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
];

export function decimalPlaces(num: number): number {
  if (Number.isInteger(num)) return 0;
  const arr = num.toString().split(".");
  return arr.length <= 1 ? 0 : (arr[1]?.length ?? 0);
}
function roundNormal(num: number, decimals: number): number {
  if (decimalPlaces(num) <= decimals) return num;
  return Math.round((num + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;
}
function roundDown(num: number, decimals: number): number {
  if (decimalPlaces(num) <= decimals) return num;
  return Math.floor(num * 10 ** decimals) / 10 ** decimals;
}
function roundUp(num: number, decimals: number): number {
  if (decimalPlaces(num) <= decimals) return num;
  return Math.ceil(num * 10 ** decimals) / 10 ** decimals;
}

export function getOrderRawAmounts(
  side: OrderSide,
  size: number,
  price: number,
  rc: RoundConfig,
): { side: OrderSide; rawMakerAmt: number; rawTakerAmt: number } {
  const rawPrice = roundNormal(price, rc.price);
  if (side === "BUY") {
    const rawTakerAmt = roundDown(size, rc.size);
    let rawMakerAmt = rawTakerAmt * rawPrice;
    if (decimalPlaces(rawMakerAmt) > rc.amount) {
      rawMakerAmt = roundUp(rawMakerAmt, rc.amount + 4);
      if (decimalPlaces(rawMakerAmt) > rc.amount) rawMakerAmt = roundDown(rawMakerAmt, rc.amount);
    }
    return { side: "BUY", rawMakerAmt, rawTakerAmt };
  }
  const rawMakerAmt = roundDown(size, rc.size);
  let rawTakerAmt = rawMakerAmt * rawPrice;
  if (decimalPlaces(rawTakerAmt) > rc.amount) {
    rawTakerAmt = roundUp(rawTakerAmt, rc.amount + 4);
    if (decimalPlaces(rawTakerAmt) > rc.amount) rawTakerAmt = roundDown(rawTakerAmt, rc.amount);
  }
  return { side: "SELL", rawMakerAmt, rawTakerAmt };
}

export interface BuildOrderInput {
  tokenId: string;
  side: OrderSide;
  price: string;
  size: string;
  /** Funds owner (maker). For EOA (type 0) this equals `signer`. */
  funder: string;
  /** Address whose key signs the order. */
  signer: string;
  /** Polymarket SignatureType. Defaults to POLY_GNOSIS_SAFE (2) for backward compat. */
  signatureType?: number;
  tickSize?: TickSize;
  /** Public builder identifier (bytes32); defaults to zero. */
  builderCode?: string | null;
  /** Order timestamp in ms (SDK default: Date.now()). */
  timestamp?: string;
  expiration?: string;
}

export interface OrderStruct {
  salt: string;
  maker: string;
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: OrderSide;
  signatureType: number;
  timestamp: string;
  metadata: string;
  builder: string;
  expiration: string;
}

export function generateOrderSalt(): string {
  return Math.round(Math.random() * Date.now()).toString();
}

export function buildOrderStruct(input: BuildOrderInput, salt = generateOrderSalt()): OrderStruct {
  const rc = ROUNDING_CONFIG[input.tickSize ?? "0.01"];
  const { side, rawMakerAmt, rawTakerAmt } = getOrderRawAmounts(
    input.side,
    parseFloat(input.size),
    parseFloat(input.price),
    rc,
  );
  return {
    salt,
    maker: getAddress(input.funder),
    signer: getAddress(input.signer),
    tokenId: input.tokenId,
    makerAmount: parseUnits(rawMakerAmt.toString(), COLLATERAL_DECIMALS).toString(),
    takerAmount: parseUnits(rawTakerAmt.toString(), COLLATERAL_DECIMALS).toString(),
    side,
    signatureType: input.signatureType ?? SIGNATURE_TYPE_POLY_GNOSIS_SAFE,
    timestamp: input.timestamp ?? Date.now().toString(),
    metadata: BYTES32_ZERO,
    builder: input.builderCode ?? BYTES32_ZERO,
    expiration: input.expiration ?? "0",
  };
}

export function buildOrderTypedData(order: OrderStruct, chainId: number, negRisk: boolean) {
  return {
    primaryType: "Order",
    types: { EIP712Domain: EIP712_DOMAIN, Order: ORDER_STRUCTURE_V2 },
    domain: {
      name: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      chainId,
      verifyingContract: negRisk ? NEG_RISK_EXCHANGE_V2 : EXCHANGE_V2,
    },
    message: {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      side: order.side === "BUY" ? 0 : 1,
      signatureType: order.signatureType,
      timestamp: order.timestamp,
      metadata: order.metadata,
      builder: order.builder,
    },
  };
}

export type OrderTypedData = ReturnType<typeof buildOrderTypedData>;

export interface BuildEoaOrderParams {
  tokenId: string;
  side: OrderSide;
  price: string;
  size: string;
  /** Embedded EOA — maker == signer == funder for signatureType 0. */
  address: string;
  chainId: number;
  negRisk?: boolean;
  tickSize?: TickSize;
  builderCode?: string | null;
  timestamp?: string;
  salt?: string;
}

/**
 * Build a signatureType-0 (EOA) order and sign it via the supplied `sign` callback.
 * The callback is generic over its error type so this stays decoupled from any
 * specific signer (the api route and the worker both pass a TradingSigner-backed
 * closure). The raw key is never seen here — `sign` returns only the signature.
 */
export async function buildAndSignEoaOrder<E>(
  params: BuildEoaOrderParams,
  sign: (typedData: OrderTypedData) => Promise<Result<{ signature: string }, E>>,
): Promise<Result<SignedClobOrder, E>> {
  const order = buildOrderStruct(
    {
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      funder: params.address,
      signer: params.address,
      signatureType: SIGNATURE_TYPE_EOA,
      builderCode: params.builderCode ?? null,
      ...(params.tickSize !== undefined ? { tickSize: params.tickSize } : {}),
      ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
    },
    params.salt,
  );
  const typedData = buildOrderTypedData(order, params.chainId, params.negRisk ?? false);
  const signed = await sign(typedData);
  if (!signed.ok) return signed;
  return ok({ ...order, signature: signed.value.signature });
}
