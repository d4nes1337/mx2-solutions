"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { useFeatureFlags } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { Empty, Skeleton, ErrorNote } from "@/components/ui";
import { TriggerAlert } from "@/components/TriggerAlert";
import { StrategyCard } from "@/components/smart-orders/StrategyCard";
import { useStrategies } from "@/lib/smart-orders/queries";
import { userStatus, GROUP_TITLES, STATUS_GROUP_ORDER } from "@/lib/smart-orders/status";
import type { StrategyRow } from "@/lib/smart-orders/queries";

const groupOf = (row: StrategyRow) =>
  userStatus(row.status, {
    actionKind: row.definitionV2.action.kind,
    execution:
      row.definitionV2.action.kind === "order" ? row.definitionV2.action.execution : undefined,
  }).group;

export default function SmartOrdersPage() {
  const session = useSession();
  const flags = useFeatureFlags();
  const signedIn = Boolean(session.data);
  const strategies = useStrategies(signedIn);

  const rows = strategies.data?.strategies ?? [];
  const groups = STATUS_GROUP_ORDER.map((g) => ({
    group: g,
    rows: rows.filter((r) => groupOf(r) === g),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Smart Orders</h1>
          <p className="mt-1 text-sm text-muted">
            Strategies that watch the market for you — and alert, prepare, or execute when your
            conditions hold.
          </p>
        </div>
        <Link
          href="/smart-orders/new"
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand bg-brand px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-brand-strong hover:bg-brand-strong"
        >
          <Sparkles size={14} aria-hidden />
          New Smart Order
        </Link>
      </div>

      {flags.data && !flags.data.conditionalRules ? (
        <Empty>Smart Orders are disabled on this server.</Empty>
      ) : !signedIn ? (
        <Empty>
          Sign in to see your Smart Orders — or{" "}
          <Link href="/smart-orders/new" className="text-accent hover:underline">
            try the builder
          </Link>{" "}
          without an account.
        </Empty>
      ) : strategies.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : strategies.error ? (
        <ErrorNote message={(strategies.error as Error).message} />
      ) : rows.length === 0 ? (
        <Empty>
          No Smart Orders yet.{" "}
          <Link href="/smart-orders/new" className="text-accent hover:underline">
            Create your first one
          </Link>{" "}
          from a template in under a minute.
        </Empty>
      ) : (
        <>
          <TriggerAlert />
          {groups.map(({ group, rows }) => (
            <section key={group} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="h-3.5 w-0.5 rounded-full bg-brand-strong" />
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {GROUP_TITLES[group]} · {rows.length}
                </h2>
              </div>
              {rows.map((row) => (
                <StrategyCard key={row.id} row={row} />
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
