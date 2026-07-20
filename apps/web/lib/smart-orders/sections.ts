/**
 * Actionability sections for the Smart Orders dashboard. Replaces the raw
 * status grouping with the question the page must answer: "where is my money
 * about to move, and what do I do right now?" — signable money first, regret
 * second, anticipation ranked by proximity, the far tail calm, terminals
 * collapsed. Pure functions over (StrategyRow, overview item) so the partition
 * is unit-testable without a network.
 */
import { userStatus } from "./status";
import type { StrategyOverviewItem, StrategyRow } from "./queries";

export type SectionId = "failed" | "ready" | "missed" | "approaching" | "watching" | "done";

export const SECTION_ORDER: readonly SectionId[] = [
  "failed",
  "ready",
  "missed",
  "approaching",
  "watching",
  "done",
];

export const SECTION_TITLES: Record<SectionId, string> = {
  failed: "Needs attention",
  ready: "Ready to sign",
  missed: "Missed — for now",
  approaching: "Approaching trigger",
  watching: "Watching",
  done: "Done",
};

/**
 * Normalized-rank cutoff between Approaching and Watching: a strategy more
 * than this many "typical moves" from its trigger reads as parked, not near.
 */
export const WATCHING_CUTOFF = 30;

/** Momentary live states (auto executing / alert firing) pin above dwell. */
const MOMENTARY_RANK = -3;

const group = (row: StrategyRow) =>
  userStatus(row.status, {
    actionKind: row.definitionV2.action.kind,
    execution:
      row.definitionV2.action.kind === "order" ? row.definitionV2.action.execution : undefined,
  }).group;

/**
 * Rank used for ordering inside Approaching/Watching. Overview-missing rows
 * keep a large-but-finite rank so first paint never demotes or reshuffles
 * them below stale ones once data arrives.
 */
export const rankOf = (row: StrategyRow, ov: StrategyOverviewItem | undefined): number => {
  if (row.status === "EXECUTING") return MOMENTARY_RANK;
  if (row.status === "TRIGGERED_AWAITING_USER") return MOMENTARY_RANK; // alert firing
  if (ov?.proximity != null) return ov.rank;
  return 1e5; // no overview yet: below every ranked row, above stale (2e6)
};

export const sectionOf = (row: StrategyRow, ov: StrategyOverviewItem | undefined): SectionId => {
  if (row.status === "EXECUTION_FAILED" || row.status === "ERROR") return "failed";
  const g = group(row);
  if (row.status === "TRIGGERED_AWAITING_USER" && row.definitionV2.action.kind === "order") {
    // Manual AND degraded-auto orders both sit on a signature — split by
    // whether the price still honors (or beats) what the user asked for.
    return ov?.actionability?.kind === "missed" ? "missed" : "ready";
  }
  if (g === "auto_executing" || g === "triggered") return "approaching"; // momentary, pinned
  if (g === "monitoring") {
    if (row.status === "ACTIVE_ACCUMULATING") return "approaching";
    if (ov?.proximity == null) return "approaching"; // first paint: benefit of the doubt
    return ov.rank < WATCHING_CUTOFF ? "approaching" : "watching";
  }
  if (g === "paused") return "watching"; // PAUSED + DRAFT: parked, editable
  return "done"; // completed | ended | anything unknown
};

const byDesc = (a: string | null, b: string | null): number => (b ?? "").localeCompare(a ?? "");

/** Per-section comparator (starred-first is applied on top by the caller). */
const sectionComparator = (
  section: SectionId,
  ov: Map<string, StrategyOverviewItem>,
): ((a: StrategyRow, b: StrategyRow) => number) => {
  switch (section) {
    case "ready":
      // Biggest dollar edge first — the money most worth acting on.
      return (a, b) =>
        (ov.get(b.id)?.actionability?.edgeUsd ?? -Infinity) -
        (ov.get(a.id)?.actionability?.edgeUsd ?? -Infinity);
    case "missed":
      // Freshest miss first — the most recoverable regret.
      return (a, b) =>
        byDesc(
          ov.get(a.id)?.actionability?.triggeredAt ?? a.updatedAt,
          ov.get(b.id)?.actionability?.triggeredAt ?? b.updatedAt,
        );
    case "approaching":
    case "watching":
      return (a, b) => rankOf(a, ov.get(a.id)) - rankOf(b, ov.get(b.id));
    default:
      return (a, b) => byDesc(a.updatedAt, b.updatedAt);
  }
};

export interface Section {
  section: SectionId;
  rows: StrategyRow[];
}

/**
 * Partition + order the dashboard. Starred rows float first within their
 * section; ties keep the per-section order; the final tiebreak (createdAt
 * desc) makes the sort fully deterministic so identical polls never shuffle.
 */
export const partitionSections = (
  rows: readonly StrategyRow[],
  overview: Map<string, StrategyOverviewItem>,
): Section[] => {
  const buckets = new Map<SectionId, StrategyRow[]>();
  for (const row of rows) {
    const id = sectionOf(row, overview.get(row.id));
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }
  return SECTION_ORDER.filter((id) => buckets.has(id)).map((id) => {
    const compare = sectionComparator(id, overview);
    const sorted = [...buckets.get(id)!].sort((a, b) => {
      const starDelta = Number(b.starredAt !== null) - Number(a.starredAt !== null);
      if (starDelta !== 0) return starDelta;
      const delta = compare(a, b);
      if (delta !== 0) return delta;
      return byDesc(a.createdAt, b.createdAt);
    });
    return { section: id, rows: sorted };
  });
};
