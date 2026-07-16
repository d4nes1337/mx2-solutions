import { createPublicClient, encodeFunctionData, getAddress, http, parseUnits } from "viem";
import { polygon } from "viem/chains";

/** Bridged USDC.e on Polygon — what users bridge in / bridge out. */
export const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/**
 * pUSD ("Polymarket USD") on Polygon — the collateral token of BOTH V2 CLOB
 * exchanges (verified on-chain 2026-07-16: `getCollateral()` on
 * 0xE111…996B and 0xe2222…0F59 return this address; see
 * docs/INTEGRATION_VERIFIED.md §23). 6 decimals, 1:1 with USD. Deposit
 * wallets hold balances in pUSD, not USDC.e — Polymarket converts inbound
 * deposits. It is an EIP-1967 upgradeable proxy and plain `transfer` to an
 * arbitrary EOA succeeds (simulated from a real deposit wallet).
 */
export const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const buildTokenTransfer = (
  token: string,
  input: { to: string; amountUsd: number },
): { target: string; value: "0"; data: string } => {
  if (!(Number.isFinite(input.amountUsd) && input.amountUsd > 0)) {
    throw new Error(`invalid transfer amount: ${input.amountUsd}`);
  }
  const to = getAddress(input.to); // throws on malformed/bad-checksum input
  return {
    target: token,
    value: "0",
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [to, parseUnits(input.amountUsd.toFixed(6), 6)],
    }),
  };
};

/** Pure USDC.e `transfer(to, amount)` calldata (6-decimal units). */
export const buildUsdcTransfer = (input: {
  to: string;
  amountUsd: number;
}): { target: string; value: "0"; data: string } => buildTokenTransfer(USDC_E_ADDRESS, input);

/**
 * Pure pUSD `transfer(to, amount)` calldata for a deposit-wallet batch — the
 * withdrawal primitive (deposit wallets hold pUSD; see PUSD_ADDRESS).
 */
export const buildPusdTransfer = (input: {
  to: string;
  amountUsd: number;
}): { target: string; value: "0"; data: string } => buildTokenTransfer(PUSD_ADDRESS, input);

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const makeBalanceReader = (rpcUrl: string, token: string): ((owner: string) => Promise<bigint>) => {
  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  return (owner) =>
    client.readContract({
      address: token as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [getAddress(owner)],
    });
};

/** Minimal on-chain USDC.e balance reader (raw 6-decimal units). */
export const createUsdcBalanceReader = (rpcUrl: string): ((owner: string) => Promise<bigint>) =>
  makeBalanceReader(rpcUrl, USDC_E_ADDRESS);

/**
 * On-chain pUSD balance reader (raw 6-decimal units) — the deposit wallet's
 * spendable balance. Used by the worker's auto-execution balance pre-check.
 */
export const createPusdBalanceReader = (rpcUrl: string): ((owner: string) => Promise<bigint>) =>
  makeBalanceReader(rpcUrl, PUSD_ADDRESS);
