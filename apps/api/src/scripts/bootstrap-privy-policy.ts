/**
 * One-shot: create the Privy wallet policy that allowlists ONLY Polymarket actions
 * (USDC.approve + CTF.setApprovalForAll to the exchanges) and denies everything else
 * — including USDC.transfer to any address. This is the destination backstop
 * (RFC-0002 §4.1, R-014). Run it once, then put the printed id in PRIVY_TRADING_POLICY_ID.
 *
 *   pnpm --filter @mx2/api exec tsx src/scripts/bootstrap-privy-policy.ts
 *
 * Requires PRIVY_APP_ID + PRIVY_APP_SECRET in the environment.
 */
import { loadConfig } from "@mx2/config";
import { createPolymarketTradingPolicy } from "@mx2/trading-signer";
import { USDC_ADDRESS, CTF_ADDRESS, ALLOWANCE_SPENDERS } from "../trade/allowance-bootstrap.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const { appId, appSecret } = config.privy;
  if (!appId || !appSecret) {
    console.error("Set PRIVY_APP_ID and PRIVY_APP_SECRET before running this script.");
    process.exit(1);
  }
  const { policyId } = await createPolymarketTradingPolicy({
    appId,
    appSecret,
    usdc: USDC_ADDRESS,
    ctf: CTF_ADDRESS,
    exchanges: [...ALLOWANCE_SPENDERS],
  });
  console.log(`\n✅ Created Polymarket-only policy.\n\nPRIVY_TRADING_POLICY_ID=${policyId}\n`);
  console.log(
    "Next: set PRIVY_TRADING_POLICY_ID in your env, then on staging verify the negative " +
      "test — a USDC.transfer to a non-exchange address must be DENIED.",
  );
};

main().catch((e: unknown) => {
  console.error("Policy creation failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
