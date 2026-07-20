"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { useFeatureFlags } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { Empty, Skeleton, ErrorNote } from "@/components/ui";
import { TriggerAlert } from "@/components/TriggerAlert";
import { DraftsSection } from "@/components/smart-orders/DraftsSection";
import { EMPTY_FILTERS, FilterBar } from "@/components/smart-orders/FilterBar";
import { StrategyCard } from "@/components/smart-orders/StrategyCard";
import { useAutoReadiness, useStrategies } from "@/lib/smart-orders/queries";
import { userStatus, GROUP_TITLES, STATUS_GROUP_ORDER } from "@/lib/smart-orders/status";
import type { StrategyRow } from "@/lib/smart-orders/queries";

const groupOf = (row: StrategyRow) =>
  userStatus(row.status, {
    actionKind: row.definitionV2.action.kind,
    execution:
      row.definitionV2.action.kind === "order" ? row.definitionV2.action.execution : undefined,
  }).group;

const matchesQuery = (row: StrategyRow, q: string): boolean => {
  const needle = q.toLowerCase();
  return (
    (row.name ?? "").toLowerCase().includes(needle) ||
    (row.definitionV2.name ?? "").toLowerCase().includes(needle) ||
    (row.tags ?? []).some((t) => t.includes(needle))
  );
};

export default function SmartOrdersPage() {
  const session = useSession();
  const flags = useFeatureFlags();
  const signedIn = Boolean(session.data);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const strategies = useStrategies(signedIn, filters.showArchived);
  const autoReadiness = useAutoReadiness(signedIn);

  const allRows = useMemo(() => strategies.data?.strategies ?? [], [strategies.data]);
  const liveRows = allRows.filter((r) => !r.archivedAt);
  const archivedRows = allRows.filter((r) => r.archivedAt);

  // Filter chips describe the UNfiltered data; filtering narrows the sections.
  const availableGroups = STATUS_GROUP_ORDER.map((g) => ({
    group: g,
    count: liveRows.filter((r) => groupOf(r) === g).length,
  })).filter((g) => g.count > 0);
  const tagVocabulary = useMemo(
    () => [...new Set(allRows.flatMap((r) => r.tags ?? []))].sort(),
    [allRows],
  );

  const applyFilters = (source: StrategyRow[]) =>
    source.filter(
      (r) =>
        (filters.group === null || groupOf(r) === filters.group) &&
        (filters.tags.length === 0 || (r.tags ?? []).some((t) => filters.tags.includes(t))) &&
        (filters.query.trim() === "" || matchesQuery(r, filters.query.trim())),
    );

  const rows = applyFilters(liveRows);
  const archived = filters.showArchived ? applyFilters(archivedRows) : [];
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

      {/* Local in-progress canvases — visible signed-out too (drafts are per-device). */}
      <DraftsSection />

      {/* Auto strategies exist but the server/account can't execute unattended:
          say it ONCE, loudly, at the top — never let AUTO silently mean
          "waiting for you to click". */}
      {signedIn &&
      (autoReadiness.data?.blockers.length ?? 0) > 0 &&
      liveRows.some(
        (r) => r.definitionV2.action.kind === "order" && r.definitionV2.action.execution === "auto",
      ) ? (
        <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-[12px] leading-snug text-warn">
          <p className="font-semibold">
            Auto-execution isn&apos;t active — your AUTO strategies will wait for manual
            confirmation.
          </p>
          <ul className="mt-1 list-disc pl-4">
            {autoReadiness.data!.blockers.slice(0, 3).map((b) => (
              <li key={b.code}>{b.detail}</li>
            ))}
          </ul>
        </div>
      ) : null}

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
      ) : allRows.length === 0 ? (
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
          <FilterBar
            filters={filters}
            onChange={setFilters}
            groups={availableGroups}
            tags={tagVocabulary}
            archivedCount={archivedRows.length}
          />
          {rows.length === 0 && archived.length === 0 ? (
            <Empty>Nothing matches the current filters.</Empty>
          ) : null}
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
          {archived.length > 0 ? (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="h-3.5 w-0.5 rounded-full bg-border-strong" />
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                  Archived · {archived.length}
                </h2>
              </div>
              {archived.map((row) => (
                <StrategyCard key={row.id} row={row} />
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
