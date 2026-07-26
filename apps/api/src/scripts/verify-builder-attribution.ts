/**
 * Builder-attribution diagnostic (brief §7.3, owner-run). Cross-references what
 * WE recorded as attributed against what Polymarket's PUBLIC builder-trades
 * endpoint actually credits to our builder code.
 *
 * It reads only:
 *   - process.env.POLYMARKET_BUILDER_CODE (the public, non-secret code)
 *   - GET https://clob.polymarket.com/builder/trades?builder_code=… (public, no auth)
 *   - local order_intents rows (status + conditionId + builder metadata)
 * and prints counts + per-market matches. It NEVER prints signatures,
 * credentials, or order payloads. Exit is non-zero only on a configuration
 * problem (missing/invalid code) — the presence of on-chain trades is
 * informational, since fills depend on the market.
 *
 * Usage:
 *   pnpm --filter @mx2/api exec tsx --env-file-if-exists=../../.env \
 *     src/scripts/verify-builder-attribution.ts [--days=7]
 */
import { isNonZeroBuilderCode } from "@mx2/core";
import { createDb } from "@mx2/db";

const CLOB_HOST = process.env.POLYMARKET_CLOB_BASE_URL ?? "https://clob.polymarket.com";

interface BuilderTrade {
  market?: string;
  assetId?: string;
  sizeUsdc?: string | number;
  status?: string;
  matchTime?: string | number;
}

const daysArg = () => {
  const raw = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const n = raw ? Number(raw) : 7;
  return Number.isFinite(n) && n > 0 ? n : 7;
};

const fetchBuilderTrades = async (builderCode: string): Promise<BuilderTrade[]> => {
  const trades: BuilderTrade[] = [];
  let cursor: string | undefined;
  // Bounded pagination so a busy builder can't spin this forever.
  for (let page = 0; page < 20; page++) {
    const url = new URL("/builder/trades", CLOB_HOST);
    url.searchParams.set("builder_code", builderCode);
    if (cursor) url.searchParams.set("next_cursor", cursor);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`builder-trades ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data?: BuilderTrade[]; next_cursor?: string };
    trades.push(...(body.data ?? []));
    if (!body.next_cursor || body.next_cursor === "LTE=" || (body.data ?? []).length === 0) break;
    cursor = body.next_cursor;
  }
  return trades;
};

const main = async () => {
  const builderCode = process.env.POLYMARKET_BUILDER_CODE;
  if (!isNonZeroBuilderCode(builderCode)) {
    console.error(
      "FAIL: POLYMARKET_BUILDER_CODE is missing, malformed, or zero — cannot verify attribution.",
    );
    process.exit(2);
  }
  console.log(`Builder code: ${builderCode}`);

  const since = new Date(Date.now() - daysArg() * 24 * 60 * 60 * 1000);

  // Local: orders WE submitted and believe are attributed.
  const dbUrl = process.env.DATABASE_URL;
  let localSubmitted = 0;
  let localAttributed = 0;
  const localMarkets = new Set<string>();
  if (dbUrl) {
    const { pool } = createDb(dbUrl);
    try {
      const { rows } = await pool.query<{
        condition_id: string | null;
        metadata: Record<string, unknown> | null;
      }>(
        "select condition_id, metadata from order_intents where status = 'submitted' and created_at >= $1",
        [since],
      );
      for (const r of rows) {
        localSubmitted += 1;
        const meta = r.metadata ?? {};
        if (meta["builderMatch"] === true) {
          localAttributed += 1;
          if (r.condition_id) localMarkets.add(r.condition_id.toLowerCase());
        }
      }
    } finally {
      await pool.end();
    }
  } else {
    console.log("(no DATABASE_URL — skipping local order_intents cross-check)");
  }

  // Upstream: what Polymarket credits to the code.
  const trades = await fetchBuilderTrades(builderCode);
  const upstreamMarkets = new Set<string>();
  let upstreamUsdc = 0;
  let latest = 0;
  for (const t of trades) {
    if (t.market) upstreamMarkets.add(String(t.market).toLowerCase());
    upstreamUsdc += Number(t.sizeUsdc ?? 0);
    const mt = Number(t.matchTime ?? 0);
    if (mt > latest) latest = mt;
  }

  console.log(`\n— Local (last ${daysArg()}d) —`);
  console.log(`  submitted intents:        ${localSubmitted}`);
  console.log(
    `  builder-attributed (ours): ${localAttributed} across ${localMarkets.size} markets`,
  );
  console.log(`\n— Polymarket builder analytics —`);
  console.log(`  attributed trades:        ${trades.length}`);
  console.log(`  attributed volume (USDC): ${upstreamUsdc.toFixed(2)}`);
  console.log(`  distinct markets:         ${upstreamMarkets.size}`);
  console.log(
    `  most recent match:        ${latest ? new Date(latest * 1000).toISOString() : "—"}`,
  );

  if (localMarkets.size > 0) {
    const matched = [...localMarkets].filter((m) => upstreamMarkets.has(m));
    const missing = [...localMarkets].filter((m) => !upstreamMarkets.has(m));
    console.log(`\n— Cross-check (local attributed markets vs upstream) —`);
    console.log(`  present in builder analytics: ${matched.length}/${localMarkets.size}`);
    if (missing.length > 0) {
      console.log(`  NOT yet visible upstream (may be unfilled or within the reporting window):`);
      for (const m of missing) console.log(`    ${m}`);
    }
  }

  console.log("\nOK: builder code is valid. Attribution presence is informational.");
  process.exit(0);
};

void main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
