"use client";

import Link from "next/link";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useFeatureFlags } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { cn, Empty, Skeleton, ErrorNote } from "@/components/ui";
import { TriggerAlert } from "@/components/TriggerAlert";
import { TriggerConfirm } from "@/components/TriggerConfirm";
import { DraftsSection } from "@/components/smart-orders/DraftsSection";
import { EMPTY_FILTERS, FilterBar } from "@/components/smart-orders/FilterBar";
import { NotifyUpsell } from "@/components/smart-orders/NotifyUpsell";
import { PulseStrip } from "@/components/smart-orders/PulseStrip";
import { StrategyCard } from "@/components/smart-orders/StrategyCard";
import { StrategyPanel } from "@/components/smart-orders/panel/StrategyPanel";
import { SheetShell } from "@/components/motion/primitives";
import { useAutoReadiness, useStrategies, useStrategiesOverview } from "@/lib/smart-orders/queries";
import {
  partitionSections,
  sectionOf,
  SECTION_ORDER,
  SECTION_TITLES,
} from "@/lib/smart-orders/sections";
import type { StrategyOverviewItem, StrategyRow } from "@/lib/smart-orders/queries";

const matchesQuery = (row: StrategyRow, q: string): boolean => {
  const needle = q.toLowerCase();
  return (
    (row.name ?? "").toLowerCase().includes(needle) ||
    (row.definitionV2.name ?? "").toLowerCase().includes(needle) ||
    (row.tags ?? []).some((t) => t.includes(needle))
  );
};

function SmartOrdersDashboard() {
  const session = useSession();
  const flags = useFeatureFlags();
  const router = useRouter();
  const searchParams = useSearchParams();
  const focus = searchParams.get("focus");
  const signedIn = Boolean(session.data);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [reviewTriggerId, setReviewTriggerId] = useState<string | null>(null);
  const strategies = useStrategies(signedIn, filters.showArchived);
  const overviewQuery = useStrategiesOverview(signedIn);
  const autoReadiness = useAutoReadiness(signedIn);

  const allRows = useMemo(() => strategies.data?.strategies ?? [], [strategies.data]);
  const liveRows = allRows.filter((r) => !r.archivedAt);
  const archivedRows = allRows.filter((r) => r.archivedAt);
  const overview = useMemo(
    () =>
      new Map<string, StrategyOverviewItem>(
        (overviewQuery.data?.strategies ?? []).map((s) => [s.id, s]),
      ),
    [overviewQuery.data],
  );

  // Filter chips describe the UNfiltered data; filtering narrows the sections.
  const availableGroups = SECTION_ORDER.map((g) => ({
    group: g,
    count: liveRows.filter((r) => sectionOf(r, overview.get(r.id)) === g).length,
  })).filter((g) => g.count > 0);
  const starredCount = liveRows.filter((r) => r.starredAt !== null).length;
  const tagVocabulary = useMemo(
    () => [...new Set(allRows.flatMap((r) => r.tags ?? []))].sort(),
    [allRows],
  );

  const applyFilters = (source: StrategyRow[]) =>
    source.filter(
      (r) =>
        (filters.group === null || sectionOf(r, overview.get(r.id)) === filters.group) &&
        (!filters.starred || r.starredAt !== null) &&
        (filters.tags.length === 0 || (r.tags ?? []).some((t) => filters.tags.includes(t))) &&
        (filters.query.trim() === "" || matchesQuery(r, filters.query.trim())),
    );

  const rows = applyFilters(liveRows);
  const archived = filters.showArchived ? applyFilters(archivedRows) : [];
  const sections = useMemo(() => partitionSections(rows, overview), [rows, overview]);

  // The panel is URL state (?focus=<id>) so selections deep-link and survive
  // reloads; replace (not push) keeps card-to-card browsing off the history.
  const openPanel = useCallback(
    (id: string) =>
      router.replace(`/smart-orders?focus=${encodeURIComponent(id)}`, { scroll: false }),
    [router],
  );
  const closePanel = useCallback(
    () => router.replace("/smart-orders", { scroll: false }),
    [router],
  );

  const renderCard = (row: StrategyRow) => (
    <StrategyCard
      key={row.id}
      row={row}
      overview={overview.get(row.id)}
      sparklines={overviewQuery.data?.sparklines}
      onOpen={openPanel}
      onReviewTrigger={setReviewTriggerId}
    />
  );

  const panel = focus ? (
    <StrategyPanel
      id={focus}
      fallbackRow={allRows.find((r) => r.id === focus)}
      onClose={closePanel}
      onFollow={openPanel}
    />
  ) : null;

  return (
    <div
      className={cn(
        panel !== null
          ? "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-start lg:gap-4"
          : undefined,
      )}
    >
      <div className="min-w-0 space-y-4">
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
          (r) =>
            r.definitionV2.action.kind === "order" && r.definitionV2.action.execution === "auto",
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
            <PulseStrip sections={sections} overview={overview} />
            <FilterBar
              filters={filters}
              onChange={setFilters}
              groups={availableGroups}
              tags={tagVocabulary}
              archivedCount={archivedRows.length}
              starredCount={starredCount}
            />
            {rows.length === 0 && archived.length === 0 ? (
              <Empty>Nothing matches the current filters.</Empty>
            ) : null}
            {sections.map(({ section, rows: sectionRows }) =>
              section === "done" ? (
                // Terminal strategies stay out of the way — one collapsed line.
                <details key={section} id={`section-${section}`} className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                    <span className="h-3.5 w-0.5 rounded-full bg-border-strong" />
                    <h2 className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                      {SECTION_TITLES[section]} · {sectionRows.length}
                    </h2>
                    <span className="text-[10px] text-faint transition-transform group-open:rotate-90">
                      ›
                    </span>
                  </summary>
                  <div className="mt-2 space-y-2">{sectionRows.map(renderCard)}</div>
                </details>
              ) : (
                <section key={section} id={`section-${section}`} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-3.5 w-0.5 rounded-full",
                        section === "failed"
                          ? "bg-neg"
                          : section === "ready"
                            ? "bg-pos"
                            : section === "missed"
                              ? "bg-warn"
                              : "bg-brand-strong",
                      )}
                    />
                    <h2
                      className={cn(
                        "text-[11px] font-semibold uppercase tracking-wide",
                        section === "failed" ? "text-neg" : "text-muted",
                      )}
                    >
                      {SECTION_TITLES[section]} · {sectionRows.length}
                    </h2>
                  </div>
                  {section === "missed" ? <NotifyUpsell signedIn={signedIn} /> : null}
                  {sectionRows.map(renderCard)}
                </section>
              ),
            )}
            {archived.length > 0 ? (
              <section className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="h-3.5 w-0.5 rounded-full bg-border-strong" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                    Archived · {archived.length}
                  </h2>
                </div>
                {archived.map(renderCard)}
              </section>
            ) : null}
          </>
        )}
        {reviewTriggerId ? (
          <TriggerConfirm triggerId={reviewTriggerId} onClose={() => setReviewTriggerId(null)} />
        ) : null}
      </div>

      {/* Side panel: sticky column on desktop, bottom sheet below lg. Both
          mounts share query caches; only one is ever visible. */}
      {panel !== null ? (
        <>
          <div className="hidden lg:sticky lg:top-16 lg:block lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto">
            {panel}
          </div>
          <div className="lg:hidden">
            <SheetShell
              open
              onClose={closePanel}
              label="Strategy details"
              panelClassName="max-h-[85vh] w-[min(94vw,560px)] overflow-y-auto"
            >
              {panel}
            </SheetShell>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function SmartOrdersPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense>
      <SmartOrdersDashboard />
    </Suspense>
  );
}
