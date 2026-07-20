/**
 * Section partition: every status lands in exactly one section, triggered
 * orders split ready/missed, ranking orders by proximity with starred pinned
 * first, and first-paint (no overview yet) never hides or demotes live rows.
 */
import { describe, it, expect } from "vitest";
import { partitionSections, sectionOf, SECTION_ORDER, WATCHING_CUTOFF } from "./sections";
import type { StrategyOverviewItem, StrategyRow } from "./queries";
import type { StrategyDefinition } from "@mx2/rules";

let seq = 0;
const def = (over: Partial<StrategyDefinition["action"] & { execution: string }> = {}) =>
  ({
    version: 2,
    name: "s",
    templateId: null,
    expr: { type: "group", id: "root", op: "and", children: [] },
    holdsForMs: 0,
    maxDataAgeMs: 5_000,
    action: {
      kind: "order",
      market: { conditionId: "c", tokenId: "t", outcome: "YES" },
      side: "BUY",
      price: 0.5,
      size: 100,
      orderType: "GTC",
      execution: "prepare",
      ...over,
    },
    recurrence: { kind: "once" },
    limits: null,
    expiresAtMs: null,
  }) as StrategyDefinition;

const row = (status: string, over: Partial<StrategyRow> = {}): StrategyRow => {
  seq += 1;
  return {
    id: over.id ?? `r${seq}`,
    walletAddress: "0xw",
    conditionId: "c",
    tokenId: "t",
    side: "BUY",
    status,
    version: 2,
    name: "s",
    templateId: null,
    tokenIds: ["t"],
    triggerCount: 0,
    cooldownUntil: null,
    trueSince: null,
    expiresAt: null,
    lastEvaluatedAt: null,
    errorMessage: null,
    tags: [],
    archivedAt: null,
    starredAt: null,
    supersedes: null,
    supersededBy: null,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    updatedAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    definitionV2: def(),
    ...over,
  };
};

const ovItem = (
  id: string,
  over: Partial<StrategyOverviewItem> = {},
): [string, StrategyOverviewItem] => [
  id,
  {
    id,
    rank: 0,
    proximity: null,
    actionability: null,
    ...over,
  },
];

const proximity = (
  rank: number,
  bindingDistance: number | null = rank / 100,
): StrategyOverviewItem["proximity"] => ({
  bindingDistance,
  bindingTokenId: "t",
  drift: null,
  dwellFraction: null,
  blockedBy: [],
  leaves: [],
});

const actionability = (
  kind: "ready" | "missed",
  over: Partial<NonNullable<StrategyOverviewItem["actionability"]>> = {},
): StrategyOverviewItem["actionability"] => ({
  kind,
  stillHolds: kind === "ready",
  triggerId: "trig",
  triggeredAt: "2026-07-19T10:00:00Z",
  priceAtTrigger: 0.45,
  priceNow: 0.48,
  edge: 0.02,
  edgeUsd: 2,
  ...over,
});

describe("sectionOf", () => {
  it("routes every engine status to exactly one section", () => {
    const cases: Record<string, string> = {
      ERROR: "failed",
      EXECUTION_FAILED: "failed",
      TRIGGERED_AWAITING_USER: "ready", // order action, no overview → optimistic
      EXECUTING: "approaching",
      ACTIVE_ACCUMULATING: "approaching",
      ACTIVE_WAITING: "approaching", // no overview yet → benefit of the doubt
      PAUSED: "watching",
      DRAFT: "watching",
      COMPLETED: "done",
      EXECUTED_MANUALLY: "done",
      EXECUTED_AUTO: "done",
      EXPIRED: "done",
      CANCELLED: "done",
      INVALIDATED: "done",
    };
    for (const [status, expected] of Object.entries(cases)) {
      expect(sectionOf(row(status), undefined), status).toBe(expected);
    }
  });

  it("splits triggered orders by actionability, defaulting to ready", () => {
    const r = row("TRIGGERED_AWAITING_USER");
    const [, ready] = ovItem(r.id, { actionability: actionability("ready") });
    const [, missed] = ovItem(r.id, { actionability: actionability("missed") });
    expect(sectionOf(r, ready)).toBe("ready");
    expect(sectionOf(r, missed)).toBe("missed");
    expect(sectionOf(r, undefined)).toBe("ready");
  });

  it("keeps an alert-kind trigger momentary in approaching", () => {
    const alertRow = row("TRIGGERED_AWAITING_USER", {
      definitionV2: { ...def(), action: { kind: "alert" } } as StrategyDefinition,
    });
    expect(sectionOf(alertRow, undefined)).toBe("approaching");
  });

  it("splits waiting strategies at the cutoff", () => {
    const near = row("ACTIVE_WAITING");
    const far = row("ACTIVE_WAITING");
    const [, nearOv] = ovItem(near.id, {
      rank: WATCHING_CUTOFF - 1,
      proximity: proximity(WATCHING_CUTOFF - 1),
    });
    const [, farOv] = ovItem(far.id, {
      rank: WATCHING_CUTOFF,
      proximity: proximity(WATCHING_CUTOFF),
    });
    expect(sectionOf(near, nearOv)).toBe("approaching");
    expect(sectionOf(far, farOv)).toBe("watching");
  });
});

describe("partitionSections", () => {
  it("orders sections by SECTION_ORDER and ranks within approaching", () => {
    const dwell = row("ACTIVE_ACCUMULATING");
    const near = row("ACTIVE_WAITING");
    const nearer = row("ACTIVE_WAITING");
    const done = row("COMPLETED");
    const failed = row("ERROR");
    const ov = new Map([
      ovItem(dwell.id, { rank: -1.8, proximity: proximity(-1.8, null) }),
      ovItem(near.id, { rank: 12, proximity: proximity(12) }),
      ovItem(nearer.id, { rank: 3, proximity: proximity(3) }),
    ]);
    const sections = partitionSections([near, done, dwell, failed, nearer], ov);
    expect(sections.map((s) => s.section)).toEqual(["failed", "approaching", "done"]);
    const approaching = sections.find((s) => s.section === "approaching")!;
    expect(approaching.rows.map((r) => r.id)).toEqual([dwell.id, nearer.id, near.id]);
    expect(SECTION_ORDER.indexOf("failed")).toBe(0);
  });

  it("floats starred rows first without breaking rank order among them", () => {
    const a = row("ACTIVE_WAITING");
    const b = row("ACTIVE_WAITING", { starredAt: "2026-07-01T00:00:00Z" });
    const c = row("ACTIVE_WAITING", { starredAt: "2026-07-02T00:00:00Z" });
    const ov = new Map([
      ovItem(a.id, { rank: 1, proximity: proximity(1) }),
      ovItem(b.id, { rank: 20, proximity: proximity(20) }),
      ovItem(c.id, { rank: 5, proximity: proximity(5) }),
    ]);
    const [section] = partitionSections([a, b, c], ov);
    // Starred first (rank order among starred), then the unstarred best rank.
    expect(section!.rows.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  it("sorts ready by dollar edge and missed by recency", () => {
    const small = row("TRIGGERED_AWAITING_USER");
    const big = row("TRIGGERED_AWAITING_USER");
    const oldMiss = row("TRIGGERED_AWAITING_USER");
    const newMiss = row("TRIGGERED_AWAITING_USER");
    const ov = new Map([
      ovItem(small.id, { actionability: actionability("ready", { edgeUsd: 1 }) }),
      ovItem(big.id, { actionability: actionability("ready", { edgeUsd: 14 }) }),
      ovItem(oldMiss.id, {
        actionability: actionability("missed", { triggeredAt: "2026-07-19T08:00:00Z" }),
      }),
      ovItem(newMiss.id, {
        actionability: actionability("missed", { triggeredAt: "2026-07-19T11:00:00Z" }),
      }),
    ]);
    const sections = partitionSections([small, oldMiss, big, newMiss], ov);
    expect(sections.find((s) => s.section === "ready")!.rows.map((r) => r.id)).toEqual([
      big.id,
      small.id,
    ]);
    expect(sections.find((s) => s.section === "missed")!.rows.map((r) => r.id)).toEqual([
      newMiss.id,
      oldMiss.id,
    ]);
  });

  it("is deterministic across identical polls (stable order)", () => {
    const rows = [row("ACTIVE_WAITING"), row("ACTIVE_WAITING"), row("ACTIVE_WAITING")];
    const ov = new Map(rows.map((r) => ovItem(r.id, { rank: 7, proximity: proximity(7) })));
    const first = partitionSections(rows, ov)[0]!.rows.map((r) => r.id);
    const second = partitionSections([...rows], ov)[0]!.rows.map((r) => r.id);
    expect(second).toEqual(first);
  });
});
