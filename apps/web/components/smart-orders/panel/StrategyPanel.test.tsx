/**
 * Side panel: inline threshold popover stages an edit, Apply runs the
 * supersede mutation (new version) and the panel follows the created id;
 * a row arriving with supersededBy auto-follows the replacement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const calls = {
  created: [] as Record<string, unknown>[],
  followed: [] as string[],
};

const state = {
  row: null as unknown,
  createdRow: { id: "new-id" },
};

vi.mock("@/lib/queries", () => ({
  useTokenPricesHistory: () => ({ data: { history: [] }, isLoading: false }),
}));
vi.mock("@/lib/smart-orders/queries", () => ({
  useStrategy: () => ({ data: state.row }),
  useStrategyEvaluation: () => ({ data: undefined }),
  useStrategyTimeline: () => ({ data: undefined }),
  useStarStrategy: () => ({ isPending: false, mutate: vi.fn() }),
  useStrategyControl: () => ({ isPending: false, mutate: vi.fn() }),
  useCreateStrategy: () => ({
    isPending: false,
    error: null,
    reset: vi.fn(),
    mutate: (
      payload: Record<string, unknown>,
      opts?: { onSuccess?: (created: { id: string }) => void },
    ) => {
      calls.created.push(payload);
      opts?.onSuccess?.(state.createdRow);
    },
  }),
}));

import { StrategyPanel } from "./StrategyPanel";
import type { StrategyRow } from "@/lib/smart-orders/queries";
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

beforeEach(() => {
  calls.created.length = 0;
  calls.followed.length = 0;
  state.row = row();
});

const renderPanel = () =>
  render(<StrategyPanel id="r1" onClose={vi.fn()} onFollow={(id) => calls.followed.push(id)} />);

describe("StrategyPanel inline edit", () => {
  it("stages a threshold via the popover, applies as a supersede, follows the new id", () => {
    renderPanel();

    // Two trigger chips render (conditions list + chart header shares state);
    // either one stages the same edit.
    fireEvent.click(screen.getAllByTitle("Edit trigger price")[0]!);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    // The re-arm warning + Apply bar appear only when dirty.
    expect(screen.getByText(/re-arms the strategy as a new version/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    expect(calls.created).toHaveLength(1);
    const payload = calls.created[0]!;
    expect(payload["supersedes"]).toBe("r1");
    const expr = payload["expr"] as {
      children: { condition: { threshold: number } }[];
    };
    expect(expr.children[0]!.condition.threshold).toBeCloseTo(0.42, 9);
    expect(calls.followed).toEqual(["new-id"]);
  });

  it("stages order price and size edits into the supersede payload", () => {
    renderPanel();

    fireEvent.click(screen.getByTitle("Edit order size"));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    fireEvent.click(screen.getByTitle("Edit limit price"));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "44" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    const action = calls.created[0]!["action"] as { price: number; size: number };
    expect(action.size).toBe(250);
    expect(action.price).toBeCloseTo(0.44, 9);
  });

  it("locks editing for terminal strategies", () => {
    state.row = row({ status: "CANCELLED" });
    renderPanel();
    expect(screen.queryByTitle("Edit trigger price")).toBeNull();
    expect(screen.queryByTitle("Edit limit price")).toBeNull();
  });

  it("auto-follows a row that arrives already superseded", () => {
    state.row = row({ supersededBy: "r2" });
    renderPanel();
    expect(calls.followed).toEqual(["r2"]);
  });
});
