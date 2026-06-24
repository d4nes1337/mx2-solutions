import { getAddress, parseUnits } from "viem";
import type { OrderSide } from "./types";

// Client-side construction + EIP-712 signing of a Polymarket CTF Exchange V2 order.
// Matches @polymarket/clob-client-v2 (ExchangeOrderBuilderV2 / orderToJsonV2).
// The CLOB defaults to version 2; V1 orders (domain version "1", nonce/feeRateBps/taker)
// are rejected with "Invalid order payload".

export interface Eip1193Provider {
  request(args: { method: string; params: unknown[] }): Promise<string>;
}

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

export const SIGNATURE_TYPE_POLY_GNOSIS_SAFE = 2;

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
  funder: string;
  signer: string;
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
    signatureType: SIGNATURE_TYPE_POLY_GNOSIS_SAFE,
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

export interface SignedOrder extends OrderStruct {
  signature: string;
}

export async function buildAndSignOrder(
  provider: Eip1193Provider,
  input: BuildOrderInput & { chainId: number; negRisk?: boolean },
): Promise<SignedOrder> {
  const order = buildOrderStruct(input);
  const typedData = buildOrderTypedData(order, input.chainId, input.negRisk ?? false);
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [order.signer, JSON.stringify(typedData)],
  });
  return { ...order, signature };
}
