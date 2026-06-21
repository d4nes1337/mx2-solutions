import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * Applies pending SQL migrations from ./drizzle. Run via `pnpm db:migrate`.
 * Idempotent: drizzle records applied migrations in a metadata table.
 */
const main = async (): Promise<void> => {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://mx2:mx2_local_dev@localhost:5432/polymarket_terminal";

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);
  try {
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
