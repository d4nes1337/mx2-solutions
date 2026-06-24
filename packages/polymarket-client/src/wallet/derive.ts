import { keccak256, getCreate2Address, encodeAbiParameters, type Hex } from "viem";

/**
 * Deterministic derivation of a user's Polymarket deposit/proxy wallet from their
 * signer EOA.
 *
 * Polymarket browser-wallet (MetaMask / EOA) users trade through a per-user Gnosis
 * Safe proxy ("Deposit Wallet", POLY_GNOSIS_SAFE / signatureType 2). That Safe
 * is deployed via CREATE2 by the Polymarket Contract Proxy Factory, so its address is
 * a pure function of the owner EOA — no on-chain lookup required.
 *
 * Constants and algorithm verified against @polymarket/builder-relayer-client
 * (`src/builder/derive.ts#deriveSafe`, `src/config/index.ts`,
 * `src/constants/index.ts`) and against the owner's known EOA→deposit-wallet pair
 * (see wallet/derive.test.ts). Recorded in docs/INTEGRATION_VERIFIED.md.
 */

// keccak256 of the Safe proxy init code (Polymarket Contract Proxy Factory deployment).
const SAFE_INIT_CODE_HASH: Hex =
  "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf";

// Polymarket Contract Proxy Factory (Gnosis Safe factory) on Polygon (chainId 137).
const SAFE_FACTORY: Hex = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Derive the Polymarket deposit (Gnosis Safe) wallet address for a signer EOA.
 * Returns a checksummed 0x address. Throws on a malformed EOA.
 */
export const deriveDepositWallet = (eoa: string): string => {
  if (!ADDRESS_RE.test(eoa)) {
    throw new Error(`deriveDepositWallet: invalid EOA address: ${eoa}`);
  }
  const salt = keccak256(encodeAbiParameters([{ name: "owner", type: "address" }], [eoa as Hex]));
  return getCreate2Address({ bytecodeHash: SAFE_INIT_CODE_HASH, from: SAFE_FACTORY, salt });
};
