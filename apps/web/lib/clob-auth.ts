import { getAddress } from "viem";
import { api } from "./api";
import type { Eip1193Provider } from "./order-sign";

// Builds + signs the Polymarket CLOB L1 "ClobAuth" EIP-712 message. The resulting
// signature lets the backend derive (or create) the user's L2 API credentials via
// POST /api/trade/credentials/setup. Verified against @polymarket/clob-client
// (src/signing/eip712.ts, src/signing/constants.ts).

const CLOB_MSG_TO_SIGN = "This message attests that I control the given wallet";

const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];

const CLOB_AUTH_TYPES = [
  { name: "address", type: "address" },
  { name: "timestamp", type: "string" },
  { name: "nonce", type: "uint256" },
  { name: "message", type: "string" },
];

export interface ClobAuthResult {
  l1Signature: string;
  timestamp: string;
  nonce: string;
}

export function buildClobAuthTypedData(
  address: string,
  chainId: number,
  timestamp: string,
  nonce: number,
) {
  return {
    primaryType: "ClobAuth",
    types: { EIP712Domain: EIP712_DOMAIN, ClobAuth: CLOB_AUTH_TYPES },
    domain: { name: "ClobAuthDomain", version: "1", chainId },
    message: { address, timestamp, nonce, message: CLOB_MSG_TO_SIGN },
  };
}

/** Fetch Polymarket CLOB server time (seconds). L1 ClobAuth must use this timestamp. */
export async function fetchClobServerTimestamp(): Promise<string> {
  const { timestamp } = await api.get<{ timestamp: number }>("/api/trade/clob-time");
  return String(timestamp);
}

/**
 * Sign the ClobAuth message with the EOA. Returns the signature + the exact
 * timestamp/nonce that were signed (the backend must forward all three so the CLOB
 * can verify the signature).
 */
export async function signClobAuth(
  provider: Eip1193Provider,
  address: string,
  chainId: number,
): Promise<ClobAuthResult> {
  const signingAddress = getAddress(address);
  const timestamp = await fetchClobServerTimestamp();
  const nonce = 0; // Polymarket's default L1 nonce.
  const typedData = buildClobAuthTypedData(signingAddress, chainId, timestamp, nonce);
  const l1Signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [signingAddress, JSON.stringify(typedData)],
  });
  return { l1Signature, timestamp, nonce: nonce.toString() };
}
