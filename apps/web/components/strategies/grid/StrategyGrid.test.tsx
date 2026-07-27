import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConditionV2, ExprNode, ExprResultNode, GroupNode, MarketRef } from "@mx2/rules";
import { emptyDoc, type StrategyDoc } from "@/lib/strategies/doc";
import type { StrategyEvaluation } from "@/lib/strategies/queries";
import { useBuilderStore } from "@/lib/strategies/store";
import { StrategyGrid } from "./StrategyGrid";

const m1: MarketRef = {
  conditionId: "c1",
  tokenId: "tok-1",
  outcome: "YES",
  title: "Fed cuts in March",
};
const m2: MarketRef = {
  conditionId: "c2",
  tokenId: "tok-2",
  outcome: "YES",
  title: "BTC above 100k",
};
const target: MarketRef = {
  conditionId: "c9",
  tokenId: "tok-9",
  outcome: "YES",
  title: "Recession in 2026",
};

const price = (market: MarketRef, threshold: number): ConditionV2 => ({
  kind: "price",
  market,
  source: "ask",
  comparator: "gte",
  threshold,
});

const cond = (id: string, c: ConditionV2): ExprNode => ({ type: "condition", id, condition: c });

const doc: StrategyDoc = {
  ...emptyDoc(),
  expr: {
    type: "group",
    id: "root",
    op: "or",
    children: [
      {
        type: "group",
        id: "g1",
        op: "and",
        children: [cond("a", price(m1, 0.67)), cond("b", price(m1, 0.6))],
      } satisfies GroupNode,
      cond("c", price(m2, 0.5)),
      cond("guard", price(target, 0.6)),
      { type: "group", id: "not1", op: "not", children: [cond("d", price(m2, 0.9))] },
    ],
  },
  holdsForMs: 300_000,
  action: {
    kind: "order",
    market: target,
    side: "BUY",
    price: 0.57,
    size: 100,
    orderType: "GTC",
    execution: "prepare",
  },
};

const resultFor = (
  id: string,
  satisfied: boolean,
  stale: boolean,
  actual: number | null,
): ExprResultNode => ({
  type: "condition",
  id,
  satisfied,
  result: {
    kind: "price",
    satisfied,
    actual,
    threshold: 0.5,
    reason: "PRICE_OK" as never,
    tokenId: "tok-1",
    stale,
  },
});

const evaluation = {
  satisfied: false,
  root: {
    type: "group",
    id: "root",
    op: "or",
    satisfied: false,
    children: [
      {
        type: "group",
        id: "g1",
        op: "and",
        satisfied: false,
        children: [resultFor("a", true, false, 0.68), resultFor("b", false, false, 0.55)],
      },
      resultFor("c", false, true, null),
      resultFor("guard", true, false, 0.62),
    ],
  },
  staleTokenIds: ["tok-2"],
  markets: [],
  strategyId: "s1",
  status: "ACTIVE_WAITING",
  holdsForMs: 300_000,
  maxDataAgeMs: 30_000,
  trueSince: null,
  triggerCount: 0,
  cooldownUntil: null,
} as StrategyEvaluation;

const history = Array.from({ length: 30 }, (_, i) => ({
  t: Date.now() - (30 - i) * 60_000,
  p: 0.5 + i * 0.005,
}));

const mockApis = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/api/markets/prices-history")) {
        const tokenId = new URL(url, "http://x").searchParams.get("tokenId") ?? "";
        return json({ tokenId, history });
      }
      if (url.includes("/economics")) {
        return json({
          feeSchedule: null,
          rewards: { minSize: null, maxSpread: null, ratePerDayUsd: null },
        });
      }
      return json({ error: "NOT_FOUND" }, 404);
    }),
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("StrategyGrid (view mode)", () => {
  it("renders WATCH cards, the IF header, the dollars-first ACT card and complex logic", async () => {
    mockApis();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StrategyGrid doc={doc} evaluation={evaluation} />
      </QueryClientProvider>,
    );

    // WATCH zone: both watched markets AND the traded market (bug: the target
    // used to be spliced out of the IF side entirely).
    expect(screen.getByText("Fed cuts in March")).toBeInTheDocument();
    expect(screen.getByText("BTC above 100k")).toBeInTheDocument();
    // The traded market appears on BOTH sides: its WATCH card (conditions +
    // chart) and the ACT card. Exactly two occurrences, never zero.
    expect(screen.getAllByText("Recession in 2026")).toHaveLength(2);
    expect(screen.getByText("also traded")).toBeInTheDocument();

    // Root combinator lives in the IF header spanning every card, not in the
    // first card's header where it read as a per-card control.
    expect(screen.getByText(/of these 3 hold at once/)).toBeInTheDocument();
    // Per-card combinator renders as an inline connector between two rows.
    expect(screen.getByText("and")).toBeInTheDocument();

    // Live condition states from the evaluation walk.
    expect(screen.getAllByText("met").length).toBe(2);
    expect(screen.getByText("not yet")).toBeInTheDocument();
    expect(screen.getByText("no data")).toBeInTheDocument();
    expect(screen.getByText("now 68¢")).toBeInTheDocument();

    // Hold window on the spine.
    expect(screen.getByText("holds 5 minutes")).toBeInTheDocument();

    // ACT zone: dollars-first order summary + execution badge.
    expect(screen.getByText("Buy YES · $57.00")).toBeInTheDocument();
    expect(screen.getByText("+$43.00 if right")).toBeInTheDocument();
    expect(screen.getByText(/at 57¢ limit · 100 shares · GTC/)).toBeInTheDocument();
    expect(screen.getByText("You sign")).toBeInTheDocument();

    // Complex logic renders read-only, never silently flattened.
    expect(screen.getByText("Grouped logic")).toBeInTheDocument();
    expect(screen.getByText("NOT")).toBeInTheDocument();

    // Charts arrive async once the mocked history resolves (3 watch + 1 target).
    await waitFor(() =>
      expect(screen.getAllByRole("img", { name: "price chart" }).length).toBeGreaterThanOrEqual(4),
    );
  });
});

describe("StrategyGrid (edit mode) — one sheet at a time", () => {
  it("opening a second editor replaces the first instead of stacking dialogs", async () => {
    mockApis();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useBuilderStore.getState().reset(doc);
    render(
      <QueryClientProvider client={client}>
        <StrategyGrid doc={doc} edit evaluation={evaluation} />
      </QueryClientProvider>,
    );

    // Open the hold-window (settings) sheet.
    fireEvent.click(screen.getByTitle("Hold window, recurrence, expiry…"));
    expect(await screen.findByText("Strategy settings")).toBeInTheDocument();

    // Opening the action editor must close settings — never two panels at once.
    fireEvent.click(screen.getAllByText("Edit order")[0]!);
    await waitFor(() => expect(screen.queryByText("Strategy settings")).toBeNull());
    expect(screen.getByText("Edit the action")).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
