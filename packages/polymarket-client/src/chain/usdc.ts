import { createPublicClient, getAddress, http } from "viem";
import { polygon } from "viem/chains";

/** Bridged USDC.e on Polygon — the collateral token of the Polymarket CLOB. */
export const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Minimal on-chain USDC.e balance reader (raw 6-decimal units). Used by the
 * worker's auto-execution balance pre-check and the wallet top-up UX.
 */
export const createUsdcBalanceReader = (rpcUrl: string): ((owner: string) => Promise<bigint>) => {
  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  return (owner) =>
    client.readContract({
      address: USDC_E_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [getAddress(owner)],
    });
};
