/**
 * Live-farming readiness pre-flight (RFC-0003 checkpoints 2–4, owner-run).
 *
 * Prints PRESENT / MISSING for every environment key the live path needs —
 * BY NAME ONLY. This script never prints, logs, or transmits a value, and it
 * reads only process.env (populated via the repo's --env-file pattern), never
 * a file. Exit code is non-zero when anything required is missing, so it
 * slots into a deploy gate.
 *
 * Usage:
 *   pnpm --filter @mx2/api exec tsx --env-file=../../.env.production \
 *     src/scripts/check-live-readiness.ts
 *
 * When the RPC + adapter addresses are present, finish with the on-chain
 * adapter verification (R-028):
 *   CONDITION_ID=0x… pnpm --filter @mx2/api exec tsx --env-file=../../.env.production \
 *     src/scripts/verify-ctf-adapters.ts
 */

interface Requirement {
  key: string;
  why: string;
  requiredFor: "withdrawals" | "orders" | "farming-live" | "all";
}

const REQUIREMENTS: Requirement[] = [
  { key: "DATABASE_URL", why: "persistence", requiredFor: "all" },
  { key: "APP_ENCRYPTION_MASTER_KEY", why: "CLOB credential encryption", requiredFor: "all" },
  { key: "POLYGON_RPC_URL", why: "balance/allowance reads + relayer SDK", requiredFor: "all" },
  { key: "PRIVY_APP_ID", why: "embedded signer (enclave)", requiredFor: "all" },
  { key: "PRIVY_APP_SECRET", why: "embedded signer (enclave)", requiredFor: "all" },
  { key: "PRIVY_AUTHORIZATION_KEY", why: "embedded signer (enclave)", requiredFor: "all" },
  { key: "POLYMARKET_RELAYER_URL", why: "gasless deposit-wallet batches", requiredFor: "all" },
  { key: "POLYMARKET_BUILDER_API_KEY", why: "relayer builder auth", requiredFor: "all" },
  { key: "POLYMARKET_BUILDER_SECRET", why: "relayer builder auth", requiredFor: "all" },
  { key: "POLYMARKET_BUILDER_PASSPHRASE", why: "relayer builder auth", requiredFor: "all" },
  { key: "CTF_ADAPTER_ADDRESS", why: "merges (verify-ctf-adapters)", requiredFor: "farming-live" },
  {
    key: "NEG_RISK_CTF_ADAPTER_ADDRESS",
    why: "neg-risk merges (verify-ctf-adapters)",
    requiredFor: "farming-live",
  },
];

/** Feature flags reported as ON/off (informational — off is a valid state). */
const FLAGS = [
  "FEATURE_LIVE_TRADING",
  "FEATURE_PRIVY_SIGNING",
  "FEATURE_RELAYER",
  "FEATURE_WALLET_WITHDRAW",
  "FEATURE_CONDITIONAL_LIVE_EXECUTION",
  "FEATURE_MAKER_LOOP",
  "FEATURE_MAKER_LOOP_LIVE",
];

const main = (): void => {
  let missing = 0;
  console.log("── Live readiness: required keys (values are never printed) ──");
  for (const req of REQUIREMENTS) {
    const present = Boolean(process.env[req.key]?.trim());
    if (!present) missing += 1;
    console.log(
      `${present ? "PRESENT" : "MISSING"}  ${req.key.padEnd(34)} ${req.why} [${req.requiredFor}]`,
    );
  }

  console.log("\n── Feature flags ──");
  for (const flag of FLAGS) {
    console.log(`${process.env[flag] === "true" ? "ON " : "off"}      ${flag}`);
  }

  console.log("\n── Next steps ──");
  if (missing > 0) {
    console.log(`✗ ${missing} required key(s) MISSING — fix the environment before any live step.`);
  } else {
    console.log("✓ Every required key is present.");
  }
  if (process.env["POLYGON_RPC_URL"] && process.env["CTF_ADAPTER_ADDRESS"]) {
    console.log(
      "→ Run the on-chain adapter verification (R-028) before FEATURE_MAKER_LOOP_LIVE:\n" +
        "  CONDITION_ID=0x… pnpm --filter @mx2/api exec tsx --env-file=../../.env.production \\\n" +
        "    src/scripts/verify-ctf-adapters.ts",
    );
  } else {
    console.log("→ verify-ctf-adapters skipped (needs POLYGON_RPC_URL + adapter addresses).");
  }

  process.exitCode = missing > 0 ? 1 : 0;
};

main();
