import { createDb } from "./client.js";
import { createAllowlistStore } from "./auth-store.js";

/**
 * Writes an ACTIVE access record for a wallet.
 *
 *   pnpm db:seed:allowlist 0xYourEoaAddress
 *
 * Login no longer needs this — access is open, and any wallet with a valid
 * EIP-712 signature can sign in. The script remains useful for one thing:
 * lifting a ban (it flips is_active back to true), which is the same effect as
 * the admin panel's grant-access. The address is lowercased to match how
 * /api/auth/verify stores and checks it.
 */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const main = async (): Promise<void> => {
  const address = process.argv[2];
  if (!address || !ADDRESS_RE.test(address)) {
    console.error("Usage: pnpm db:seed:allowlist <0xWalletAddress>");
    process.exit(1);
  }

  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://mx2:mx2_local_dev@localhost:5432/polymarket_terminal";
  const handle = createDb(databaseUrl);
  const allowlist = createAllowlistStore(handle.db);

  try {
    const row = await allowlist.add(address.toLowerCase(), "seed-script", "local dev allowlist");
    console.log(`Allowlisted ${row.walletAddress} (active=${row.isActive}).`);
  } finally {
    await handle.close();
  }
};

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
