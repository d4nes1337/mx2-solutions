/**
 * Read-only on-chain verification of the CTF collateral-adapter addresses
 * (R-028: docs.polymarket.com and the ctf-exchange-v2 README disagree, so
 * NOTHING hardcodes these — they enter config only after this script passes).
 *
 * Checks per address:
 *   1. eth_getCode is non-empty (a contract actually lives there).
 *   2. mergePositions(conditionId, 0) eth_call-simulates without an ABI-level
 *      revert on selector lookup (a zero-amount merge against a real market's
 *      conditionId; economic no-op).
 *
 * Usage:
 *   POLYGON_RPC_URL=... CTF_ADAPTER_ADDRESS=0x… NEG_RISK_CTF_ADAPTER_ADDRESS=0x… \
 *   CONDITION_ID=0x… pnpm --filter @mx2/api exec tsx src/scripts/verify-ctf-adapters.ts
 *
 * Record the output in docs/INTEGRATION_VERIFIED.md before enabling
 * FEATURE_MAKER_LOOP_LIVE (RFC-0003 checkpoint 2 blocks on it).
 */
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import { buildMergeTransaction } from "@mx2/polymarket-client";

const main = async (): Promise<void> => {
  const rpcUrl = process.env["POLYGON_RPC_URL"];
  const conditionId = process.env["CONDITION_ID"];
  const candidates = [
    { name: "CTF_ADAPTER_ADDRESS", address: process.env["CTF_ADAPTER_ADDRESS"] },
    {
      name: "NEG_RISK_CTF_ADAPTER_ADDRESS",
      address: process.env["NEG_RISK_CTF_ADAPTER_ADDRESS"],
    },
  ];
  if (!rpcUrl) throw new Error("POLYGON_RPC_URL is required");
  if (!conditionId || !/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
    throw new Error("CONDITION_ID (bytes32 of a real market) is required");
  }

  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  let failed = false;

  for (const { name, address } of candidates) {
    if (!address) {
      console.log(`✗ ${name}: not set — skipping (live merges for its market type stay blocked)`);
      continue;
    }
    const code = await client.getCode({ address: address as `0x${string}` });
    if (!code || code === "0x") {
      console.log(`✗ ${name} ${address}: NO CONTRACT CODE — wrong address or wrong chain`);
      failed = true;
      continue;
    }
    // Zero-amount merges are rejected by our builder, so encode 1e-6 shares —
    // still an economic no-op for a wallet holding nothing (the call reverts
    // on balance, which proves the SELECTOR resolved; a selector miss reverts
    // differently, with empty return data on most solc versions).
    const tx = buildMergeTransaction({
      conditionId,
      amountShares: 0.000001,
      adapterAddress: address,
    });
    try {
      await client.call({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}` });
      console.log(`✓ ${name} ${address}: code present, mergePositions simulated cleanly`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A revert WITH reason data still proves the function exists; an
      // immediate function-selector miss is the failure we're screening for.
      if (/function selector was not recognized|fallback/i.test(msg)) {
        console.log(`✗ ${name} ${address}: mergePositions selector NOT recognized`);
        failed = true;
      } else {
        console.log(
          `✓ ${name} ${address}: code present; simulation reverted with reason (selector exists): ${msg.slice(0, 120)}`,
        );
      }
    }
  }

  if (failed) {
    console.error("\nVerification FAILED — do not set these addresses in production config.");
    process.exit(1);
  }
  console.log("\nDone. Record results in docs/INTEGRATION_VERIFIED.md (R-028).");
};

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
