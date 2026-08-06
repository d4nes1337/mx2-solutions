/**
 * Real-Postgres proof of the atomic trigger commit — the pieces fakes cannot
 * vouch for: the partial unique expression index, transaction rollback, and
 * NOTIFY-on-commit. Runs ONLY when DATABASE_URL_TEST is set (point it at the
 * docker-compose Postgres); skips cleanly otherwise.
 *
 *   DATABASE_URL_TEST=postgresql://mx2:mx2_local_dev@localhost:5432/polymarket_terminal \
 *     pnpm vitest run packages/db/src/trigger-commit.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema.js";
import { conditionalRules, notificationOutbox, ruleTriggers } from "./schema.js";
import { createRuleStore } from "./conditional-store.js";
import { commitTriggerAtomically, EVENT_BUS_CHANNEL } from "./trigger-commit.js";
import type { Database } from "./client.js";

const DATABASE_URL = process.env["DATABASE_URL_TEST"];

const WALLET = "0x-trigger-commit-itest";

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("commitTriggerAtomically (real Postgres)", () => {
  let pool: pg.Pool;
  let db: Database;
  let listener: pg.Client;
  const notified: string[] = [];

  const evidence = (triggerNumber: number): Record<string, unknown> => ({
    triggerNumber,
    windowStartMs: 1000,
    triggeredAtMs: 2000,
    reasonCodes: ["PRICE_MOVE_OK"],
  });

  const stateUpdate = {
    status: "TRIGGERED_AWAITING_USER" as const,
    trueSinceMs: 1000,
    lastEvaluatedAt: new Date(),
    triggerCount: 1,
    cooldownUntilMs: null,
    watermarks: {},
    staleSinceMs: null,
  };

  const makeRule = async (): Promise<string> => {
    const store = createRuleStore(db);
    const row = await store.create({
      walletAddress: WALLET,
      conditionId: "itest-cond",
      tokenId: "itest-token",
      side: "BUY",
      definition: { version: 2 } as never,
      definitionHash: `hash-${Math.random()}`,
      expiresAt: null,
      version: 2,
      name: "itest",
      tokenIds: ["itest-token"],
    });
    return row.id;
  };

  const commitOpts = (ruleId: string, triggerNumber = 1) => ({
    ruleId,
    stateUpdate,
    trigger: {
      walletAddress: WALLET,
      evidence: evidence(triggerNumber) as never,
      reasonCodes: [] as never[],
      status: "awaiting_user" as const,
    },
    outboxItem: (triggerId: string) => ({
      walletAddress: WALLET,
      kind: "order_awaiting_signature",
      dedupeKey: `trigger:${triggerId}:sign`,
      payload: { triggerId },
    }),
    notify: (triggerId: string) => ({ kind: "rule.triggered", triggerId }),
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
    db = drizzle(pool, { schema }) as Database;
    await migrate(drizzle(pool), {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
    listener = new pg.Client({ connectionString: DATABASE_URL });
    await listener.connect();
    listener.on("notification", (n) => {
      if (n.payload) notified.push(n.payload);
    });
    await listener.query(`LISTEN ${EVENT_BUS_CHANNEL}`);
  });

  afterAll(async () => {
    await db.delete(ruleTriggers).where(eq(ruleTriggers.walletAddress, WALLET));
    await db.delete(notificationOutbox).where(eq(notificationOutbox.walletAddress, WALLET));
    await db.delete(conditionalRules).where(eq(conditionalRules.walletAddress, WALLET));
    await listener.end();
    await pool.end();
  });

  it("commits state + trigger + outbox together and NOTIFYs on commit", async () => {
    const ruleId = await makeRule();
    const result = await commitTriggerAtomically(db, commitOpts(ruleId));
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") return;

    expect(result.rule.status).toBe("TRIGGERED_AWAITING_USER");
    const [outboxRow] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.dedupeKey, `trigger:${result.trigger.id}:sign`));
    expect(outboxRow).toBeDefined();

    // NOTIFY is delivered asynchronously after commit.
    await new Promise((r) => setTimeout(r, 300));
    const mine = notified.map((p) => JSON.parse(p) as { triggerId?: string });
    expect(mine.some((p) => p.triggerId === result.trigger.id)).toBe(true);
  });

  it("cas_lost when the rule is not evaluable — zero writes", async () => {
    const ruleId = await makeRule();
    await db
      .update(conditionalRules)
      .set({ status: "PAUSED" })
      .where(eq(conditionalRules.id, ruleId));
    const result = await commitTriggerAtomically(db, commitOpts(ruleId));
    expect(result.outcome).toBe("cas_lost");
    const triggers = await db.select().from(ruleTriggers).where(eq(ruleTriggers.ruleId, ruleId));
    expect(triggers).toHaveLength(0);
  });

  it("the unique index dedupes concurrent same-triggerNumber commits to ONE row", async () => {
    const ruleId = await makeRule();
    // Both must survive the CAS (both see ACTIVE → TRIGGERED is not evaluable
    // for the second) — so run against a repeat-style state that stays
    // evaluable: keep status ACTIVE_ACCUMULATING in the update.
    const opts = {
      ...commitOpts(ruleId),
      stateUpdate: { ...stateUpdate, status: "ACTIVE_WAITING" as const },
    };
    const results = await Promise.all([
      commitTriggerAtomically(db, opts),
      commitTriggerAtomically(db, opts),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["committed", "duplicate"]);
    const triggers = await db
      .select()
      .from(ruleTriggers)
      .where(and(eq(ruleTriggers.ruleId, ruleId), sql`(evidence->>'triggerNumber')::int = 1`));
    expect(triggers).toHaveLength(1);
  });

  it("rolls back EVERYTHING when a late step fails inside the transaction", async () => {
    const ruleId = await makeRule();
    const opts = {
      ...commitOpts(ruleId),
      outboxItem: () => {
        throw new Error("injected failure inside tx");
      },
    };
    await expect(commitTriggerAtomically(db, opts)).rejects.toThrow("injected failure");
    // Nothing committed: rule still ACTIVE, no trigger row.
    const [rule] = await db.select().from(conditionalRules).where(eq(conditionalRules.id, ruleId));
    expect(rule!.status).toBe("ACTIVE_WAITING");
    const triggers = await db.select().from(ruleTriggers).where(eq(ruleTriggers.ruleId, ruleId));
    expect(triggers).toHaveLength(0);
  });
});
