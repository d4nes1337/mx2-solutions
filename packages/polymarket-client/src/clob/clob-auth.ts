import { getAddress } from "viem";

// Pure construction of the Polymarket CLOB L1 "ClobAuth" EIP-712 message. Signing
// this proves wallet ownership so the backend can derive (or create) the user's L2
// API credentials. Ported from apps/web/lib/clob-auth.ts minus the browser provider
// call: here the typed data is signed server-side via the TradingSigner seam (Privy),
// so credential setup needs no wallet popup. Verified against @polymarket/clob-client
// (src/signing/eip712.ts, src/signing/constants.ts).

const CLOB_MSG_TO_SIGN = "This message attests that I control the given wallet";
/** Polymarket's default L1 nonce. */
export const CLOB_AUTH_DEFAULT_NONCE = 0 as const;

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

export function buildClobAuthTypedData(
  address: string,
  chainId: number,
  timestamp: string,
  nonce: number = CLOB_AUTH_DEFAULT_NONCE,
) {
  return {
    primaryType: "ClobAuth",
    types: { EIP712Domain: EIP712_DOMAIN, ClobAuth: CLOB_AUTH_TYPES },
    domain: { name: "ClobAuthDomain", version: "1", chainId },
    message: { address: getAddress(address), timestamp, nonce, message: CLOB_MSG_TO_SIGN },
  };
}
