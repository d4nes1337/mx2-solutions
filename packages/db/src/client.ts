import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  /** Lightweight liveness check used by readiness probes. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const createDb = (databaseUrl: string): DbHandle => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async ping() {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
};
