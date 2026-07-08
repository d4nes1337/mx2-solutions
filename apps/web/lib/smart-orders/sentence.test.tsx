import { describe, expect, it } from "vitest";
import type { MarketRef } from "@mx2/rules";
import { humanDuration, strategySentence } from "./sentence";
import { TEMPLATES, templateById } from "./templates";
import { emptyDoc, freshNodeId } from "./doc";
import { userStatus } from "./status";
import { compileDoc, validateDoc } from "./compile";
import { useBuilderStore } from "./store";

const market: MarketRef = { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" };
const meta = { title: "Will it rain tomorrow?" };

/** Words that must never reach user-facing copy (advanced panels excepted). */
const FORBIDDEN = [
  /predicate/i,
  /cumulative[_ ]?notional/i,
  /maxdataage/i,
  /signaturetype/i,
  /fail-closed/i,
  /relayer/i,
  /privy/i,
];

describe("strategySentence", () => {
  it("reads the re-entry template as plain English", () => {
    const doc = templateById("re-entry")!.build(market, meta);
    const s = strategySentence(doc);
    expect(s).toContain("If");
    expect(s).toContain("YES price of Will it rain tomorrow? is below 58¢");
    expect(s).toContain("$2k of ask liquidity");
    expect(s).toContain("holding for 5 minutes");
    expect(s).toContain("buy 100 YES at 57¢");
    expect(s).toContain("ask me to sign");
  });

  it("describes cross-market templates with an unbound placeholder", () => {
    const doc = templateById("cross-market")!.build(market, meta);
    const s = strategySentence(doc);
    expect(s).toContain("is above 70¢");
    expect(s).toContain("pick a market");
    expect(s).toContain("alert me");
  });

  it("describes repeat recurrence and auto execution", () => {
    const doc = templateById("re-entry")!.build(market, meta);
    doc.action = { ...doc.action, kind: "order", execution: "auto" } as typeof doc.action;
    doc.recurrence = { kind: "repeat", maxRepeats: 5, cooldownMs: 600_000 };
    const s = strategySentence(doc);
    expect(s).toContain("automatically from my Arima trading wallet");
    expect(s).toContain("repeat up to 5×");
  });

  it("never leaks internal vocabulary", () => {
    for (const template of TEMPLATES) {
      const s = strategySentence(template.build(market, meta));
      for (const banned of FORBIDDEN) {
        expect(s).not.toMatch(banned);
      }
    }
  });

  it("formats durations for humans", () => {
    expect(humanDuration(0)).toBe("instantly");
    expect(humanDuration(30_000)).toBe("30 seconds");
    expect(humanDuration(300_000)).toBe("5 minutes");
    expect(humanDuration(3_600_000)).toBe("1 hour");
  });
});

describe("userStatus", () => {
  it("maps internal states to calm labels without jargon", () => {
    expect(userStatus("ACTIVE_WAITING").label).toBe("Monitoring");
    expect(userStatus("ACTIVE_ACCUMULATING").label).toBe("Conditions holding…");
    expect(
      userStatus("TRIGGERED_AWAITING_USER", { actionKind: "order", execution: "prepare" }).group,
    ).toBe("waiting_signature");
    expect(userStatus("TRIGGERED_AWAITING_USER", { actionKind: "alert" }).group).toBe("triggered");
    expect(userStatus("EXECUTING").label).toBe("Auto-executing");
    expect(userStatus("EXECUTION_FAILED").label).toBe("Needs attention");
    expect(userStatus("COMPLETED").group).toBe("completed");
    for (const status of ["ACTIVE_WAITING", "EXECUTING", "EXECUTION_FAILED", "INVALIDATED"]) {
      for (const banned of FORBIDDEN) expect(userStatus(status).label).not.toMatch(banned);
    }
  });
});

describe("maker estimator", async () => {
  const { estimateMakerQuote } = await import("./maker-estimate");
  const base = {
    price: 0.5,
    size: 200,
    side: "BUY" as const,
    bestBid: 0.49,
    bestAsk: 0.51,
    rewardsMinSize: 100,
    rewardsMaxSpread: 3,
  };

  it("qualifies a resting quote near the mid at program size", () => {
    const e = estimateMakerQuote(base);
    expect(e.qualifies).toBe(true);
    expect(e.capitalUsd).toBe(100); // 0.5 × 200
    expect(e.distanceFromMidCents).toBe(0);
    expect(e.maxDownsideUsd).toBe(100);
  });

  it("fails qualification on size and explains how to fix it", () => {
    const e = estimateMakerQuote({ ...base, size: 50 });
    expect(e.qualifies).toBe(false);
    expect(e.meetsMinSize).toBe(false);
    expect(e.notes.join(" ")).toMatch(/Increase the size/);
  });

  it("fails qualification when the quote sits too far from mid", () => {
    const e = estimateMakerQuote({ ...base, price: 0.4 });
    expect(e.withinMaxSpread).toBe(false);
    expect(e.notes.join(" ")).toMatch(/closer to the mid/);
  });

  it("never invents reward numbers and stays unknown without params", () => {
    const e = estimateMakerQuote({ ...base, rewardsMinSize: null, rewardsMaxSpread: null });
    expect(e.qualifies).toBeNull();
    expect(e.notes.join(" ")).toMatch(/does not advertise/);
    expect(JSON.stringify(e)).not.toMatch(/reward.*\$\d/i);
  });
});

describe("builder store + compile", () => {
  it("adds, negates, and removes conditions immutably", () => {
    const store = useBuilderStore.getState();
    store.reset(emptyDoc());

    const id = useBuilderStore
      .getState()
      .addCondition({ kind: "price", market, source: "ask", comparator: "lte", threshold: 0.4 });
    expect(useBuilderStore.getState().doc.expr.children).toHaveLength(1);

    useBuilderStore.getState().toggleNot(id);
    const wrapped = useBuilderStore.getState().doc.expr.children[0]!;
    expect(wrapped.type).toBe("group");
    if (wrapped.type === "group") expect(wrapped.op).toBe("not");

    useBuilderStore.getState().toggleNot(id);
    expect(useBuilderStore.getState().doc.expr.children[0]!.type).toBe("condition");

    useBuilderStore.getState().removeNode(id);
    expect(useBuilderStore.getState().doc.expr.children).toHaveLength(0);
  });

  it("flags unbound markets and clears once bound", () => {
    useBuilderStore.getState().reset(templateById("cross-market")!.build(market, meta));
    const before = validateDoc(useBuilderStore.getState().doc);
    expect(before.some((i) => i.code === "MARKET_UNBOUND")).toBe(true);

    const unboundLeaf = useBuilderStore
      .getState()
      .doc.expr.children.find(
        (c) =>
          c.type === "condition" &&
          c.condition.kind === "price" &&
          c.condition.market.tokenId === "",
      );
    expect(unboundLeaf).toBeTruthy();
    useBuilderStore.getState().bindMarket(
      unboundLeaf!.id,
      { conditionId: "cond-2", tokenId: "tok-2", outcome: "NO" },
      {
        title: "Other market",
      },
    );
    const after = validateDoc(useBuilderStore.getState().doc);
    expect(after.some((i) => i.code === "MARKET_UNBOUND")).toBe(false);
  });

  it("compiles a doc to a clean v2 definition without editor metadata", () => {
    const doc = templateById("re-entry")!.build(market, meta);
    doc.positions[freshNodeId()] = { x: 1, y: 2 };
    const def = compileDoc(doc);
    expect(def.version).toBe(2);
    expect(def.templateId).toBe("re-entry");
    expect("positions" in def).toBe(false);
    expect("marketMeta" in def).toBe(false);
    expect("selectedNodeId" in def).toBe(false);
  });

  it("requires limits before an auto strategy validates", () => {
    const doc = templateById("re-entry")!.build(market, meta);
    doc.action = { ...doc.action, kind: "order", execution: "auto" } as typeof doc.action;
    expect(validateDoc(doc).some((i) => i.code === "AUTO_REQUIRES_LIMITS")).toBe(true);
    doc.limits = { maxNotionalPerOrder: 100, maxDailyNotional: 200, maxTotalNotional: 500 };
    expect(validateDoc(doc).some((i) => i.code === "AUTO_REQUIRES_LIMITS")).toBe(false);
  });
});
