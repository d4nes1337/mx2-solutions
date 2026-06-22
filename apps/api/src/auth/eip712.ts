import { verifyTypedData, recoverTypedDataAddress } from "viem";
import { randomBytes } from "node:crypto";

const LOGIN_STATEMENT = "Sign in to MX2 Terminal";

// EIP-712 domain — sent to client as JSON (chainId is a number).
// When verifying, chainId is converted to bigint for viem's verifyTypedData.
interface LoginDomain {
  name: string;
  version: string;
  chainId: number;
}

// EIP712Domain MUST be declared explicitly. MetaMask (via @metamask/eth-sig-util
// V4) reads this to compute the domain separator. Omitting it makes the wallet
// fall back to a non-standard domain-type field set, producing a hash that does
// not match viem's — the signature then recovers to a different address.
const LOGIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
  Login: [
    { name: "statement", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
  ],
} as const;

export interface LoginTypedData {
  domain: LoginDomain;
  types: typeof LOGIN_TYPES;
  primaryType: "Login";
  message: { statement: string; nonce: string; issuedAt: string };
}

export interface LoginChallenge {
  nonce: string;
  issuedAt: string;
  typedData: LoginTypedData;
}

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// viem requires chainId as bigint when EIP712Domain declares it uint256.
// The JSON-facing LoginDomain keeps chainId as a number; this builds the
// bigint-flavoured domain that viem's sign/verify/recover functions expect.
const viemDomain = (chainId: number | string) => ({
  name: "MX2 Terminal",
  version: "1",
  chainId: BigInt(chainId),
});

export const createLoginChallenge = (chainId: number): LoginChallenge => {
  const nonce = `0x${randomBytes(16).toString("hex")}`;
  const issuedAt = new Date().toISOString();
  const domain: LoginDomain = {
    name: "MX2 Terminal",
    version: "1",
    chainId,
  };
  return {
    nonce,
    issuedAt,
    typedData: {
      domain,
      types: LOGIN_TYPES,
      primaryType: "Login",
      message: { statement: LOGIN_STATEMENT, nonce, issuedAt },
    },
  };
};

export const verifyLoginSignature = async (
  challenge: { nonce: string; issuedAt: string; chainId: number },
  signature: string,
  claimedAddress: string,
): Promise<boolean> => {
  try {
    const valid = await verifyTypedData({
      domain: viemDomain(challenge.chainId),
      types: LOGIN_TYPES,
      primaryType: "Login",
      message: { statement: LOGIN_STATEMENT, nonce: challenge.nonce, issuedAt: challenge.issuedAt },
      address: claimedAddress as `0x${string}`,
      signature: signature as `0x${string}`,
    });
    return valid;
  } catch {
    return false;
  }
};

// ── Diagnostics ─────────────────────────────────────────────────────────────
// These are used only for troubleshooting signature mismatches. They recover the
// signer address so we can compare the server's reconstruction against the exact
// payload the client signed, pinpointing any field that diverges.

/** Recover the signer using the server's reconstruction of the challenge. */
export const recoverLoginAddress = async (
  challenge: { nonce: string; issuedAt: string; chainId: number },
  signature: string,
): Promise<string | null> => {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: viemDomain(challenge.chainId),
      types: LOGIN_TYPES,
      primaryType: "Login",
      message: { statement: LOGIN_STATEMENT, nonce: challenge.nonce, issuedAt: challenge.issuedAt },
      signature: signature as `0x${string}`,
    });
    return recovered.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Recover the signer from the exact typed-data payload the client claims it
 * signed. `chainId` arrives as a number over JSON and is coerced to bigint.
 */
export const recoverFromRawTypedData = async (
  rawTypedData: unknown,
  signature: string,
): Promise<string | null> => {
  try {
    const td = rawTypedData as {
      domain: { name: string; version: string; chainId: number | string };
      message: { statement: string; nonce: string; issuedAt: string };
    };
    const recovered = await recoverTypedDataAddress({
      domain: viemDomain(td.domain.chainId),
      types: LOGIN_TYPES,
      primaryType: "Login",
      message: td.message,
      signature: signature as `0x${string}`,
    });
    return recovered.toLowerCase();
  } catch {
    return null;
  }
};
