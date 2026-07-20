/**
 * Chart-first strategy card: per-section hero metric, star pin, and the
 * Review & sign / Re-arm wiring for triggered strategies. Signing itself is
 * out of scope — the card only hands a triggerId to the confirm flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const calls = {
  star: [] as { id: string; starred: boolean }[],
  review: [] as string[],
  dismissed: [] as string[],
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries", () => ({
  useDismissTrigger: () => ({
    isPending: false,
    mutate: (id: string) => calls.dismissed.push(id),
  }),
}));
vi.mock("@/lib/smart-orders/store", () => ({
  useBuilderStore: (sel: (s: { spawnDraft: () => string }) => unknown) =>
    sel({ spawnDraft: () => "draft-1" }),
}));
vi.mock("@/lib/smart-orders/queries", () => ({
  useCreateStrategy: () => ({ isPending: false, error: null, mutate: vi.fn() }),
  useSetStrategyTags: () => ({ mutate: vi.fn() }),
  useStrategyControl: () => ({ isPending: false, mutate: vi.fn() }),
  useStarStrategy: () => ({
    isPending: false,
    mutate: (v: { id: string; starred: boolean }) => calls.star.push(v),
  }),
}));
vi.mock("./QuickEditSheet", () => ({ QuickEditSheet: () => null }));
vi.mock("@/components/charts/AreaChart", () => ({
  AreaChart: (props: { baselines?: { value: number; label?: string }[] }) => (
    <div data-testid="mini-chart">{props.baselines?.map((b) => b.label).join(",")}</div>
  ),
}));

import { StrategyCard } from "./StrategyCard";
import type { StrategyOverviewItem, StrategyRow } from "@/lib/smart-orders/queries";
import type { StrategyDefinition } from "@mx2/rules";

const def: StrategyDefinition = {
  version: 2,
  name: "Dip buy",
  templateId: null,
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "p1",
        condition: {
          kind: "price",
          market: { conditionId: "c1", tokenId: "tok-1", outcome: "YES", title: "Test market" },
          source: "ask",
          comparator: "lte",
          threshold: 0.5,
        },
      },
    ],
  },
  holdsForMs: 600_000,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: { conditionId: "c1", tokenId: "tok-1", outcome: "YES", title: "Test market" },
    side: "BUY",
    price: 0.49,
    size: 100,
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
};

const row = (over: Partial<StrategyRow> = {}): StrategyRow => ({
  id: "r1",
  walletAddress: "0xw",
  conditionId: "c1",
  tokenId: "tok-1",
  side: "BUY",
  status: "ACTIVE_WAITING",
  version: 2,
  name: "Dip buy",
  templateId: null,
  tokenIds: ["tok-1"],
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
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
  definitionV2: def,
  ...over,
});

const item = (over: Partial<StrategyOverviewItem>): StrategyOverviewItem => ({
  id: "r1",
  rank: 0,
  proximity: null,
  actionability: null,
  ...over,
});

beforeEach(() => {
  calls.star.length = 0;
  calls.review.length = 0;
  calls.dismissed.length = 0;
});

describe("StrategyCard hero metric", () => {
  it("shows the edge and Review & sign for a ready trigger", () => {
    render(
      <StrategyCard
        row={row({ status: "TRIGGERED_AWAITING_USER" })}
        overview={item({
          actionability: {
            kind: "ready",
            stillHolds: true,
            triggerId: "trig-1",
            triggeredAt: "2026-07-19T10:00:00Z",
            priceAtTrigger: 0.45,
            priceNow: 0.48,
            edge: 0.02,
            edgeUsd: 2,
          },
        })}
        onReviewTrigger={(id) => calls.review.push(id)}
      />,
    );
    expect(screen.getByText(/2\.0¢ better/)).toBeDefined();
    expect(screen.getByText(/\+\$2\.00 on your size/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Review & sign/ }));
    expect(calls.review).toEqual(["trig-1"]);
  });

  it("shows the regret line, Sign anyway and Re-arm for a missed trigger", () => {
    render(
      <StrategyCard
        row={row({ status: "TRIGGERED_AWAITING_USER" })}
        overview={item({
          actionability: {
            kind: "missed",
            stillHolds: false,
            triggerId: "trig-2",
            triggeredAt: "2026-07-19T10:00:00Z",
            priceAtTrigger: 0.45,
            priceNow: 0.56,
            edge: -0.06,
            edgeUsd: -6,
          },
        })}
        onReviewTrigger={(id) => calls.review.push(id)}
      />,
    );
    expect(screen.getByText(/hit 45¢ · now 56¢/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Sign anyway/ }));
    expect(calls.review).toEqual(["trig-2"]);
    fireEvent.click(screen.getByRole("button", { name: /Re-arm/ }));
    expect(calls.dismissed).toEqual(["trig-2"]);
  });

  it("shows a live dwell bar while the hold window runs", () => {
    render(
      <StrategyCard
        row={row({
          status: "ACTIVE_ACCUMULATING",
          trueSince: new Date(Date.now() - 300_000).toISOString(),
        })}
      />,
    );
    expect(screen.getByText(/holding 50%/)).toBeDefined();
  });

  it("shows the distance + drift for a waiting strategy", () => {
    render(
      <StrategyCard
        row={row()}
        overview={item({
          rank: 2.3,
          proximity: {
            bindingDistance: 0.023,
            bindingTokenId: "tok-1",
            drift: "approaching",
            dwellFraction: null,
            blockedBy: [],
            leaves: [],
          },
        })}
      />,
    );
    expect(screen.getByText(/2\.3¢ away/)).toBeDefined();
    expect(screen.getByText("closing in")).toBeDefined();
  });

  it("names the blocking gate instead of faking a distance", () => {
    render(
      <StrategyCard
        row={row()}
        overview={item({
          rank: 1e6,
          proximity: {
            bindingDistance: null,
            bindingTokenId: "tok-1",
            drift: null,
            dwellFraction: null,
            blockedBy: ["liquidity"],
            leaves: [],
          },
        })}
      />,
    );
    expect(screen.getByText(/blocked by liquidity/)).toBeDefined();
  });
});

describe("StrategyCard star + chart", () => {
  it("fires the star mutation from the pin toggle", () => {
    render(<StrategyCard row={row()} />);
    fireEvent.click(screen.getByRole("button", { name: "Star strategy" }));
    expect(calls.star).toEqual([{ id: "r1", starred: true }]);
  });

  it("draws the mini chart with the trigger line when a sparkline exists", () => {
    render(
      <StrategyCard
        row={row()}
        overview={item({
          proximity: {
            bindingDistance: 0.02,
            bindingTokenId: "tok-1",
            drift: null,
            dwellFraction: null,
            blockedBy: [],
            leaves: [],
          },
        })}
        sparklines={{
          "tok-1": [
            { t: 1_700_000_000, p: 0.44 },
            { t: 1_700_000_900, p: 0.48 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("mini-chart").textContent).toBe("50¢");
  });

  it("skips the chart without series data", () => {
    render(<StrategyCard row={row()} />);
    expect(screen.queryByTestId("mini-chart")).toBeNull();
  });
});
