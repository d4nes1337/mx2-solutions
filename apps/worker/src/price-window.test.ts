import { describe, expect, it } from "vitest";
import { createPriceWindowStore } from "./price-window.js";

const HOUR = 3_600_000;

describe("price window store", () => {
  it("keeps samples oldest-first and snapshots are stable between pushes", () => {
    const store = createPriceWindowStore();
    store.push("tok", 0.5, 1_000);
    store.push("tok", 0.6, 2_000);
    const snap1 = store.history("tok");
    expect(snap1).toEqual([
      { t: 1_000, p: 0.5 },
      { t: 2_000, p: 0.6 },
    ]);
    expect(store.history("tok")).toBe(snap1); // cached
    store.push("tok", 0.55, 3_000);
    expect(store.history("tok")).not.toBe(snap1); // invalidated
  });

  it("rejects junk prices and out-of-order timestamps", () => {
    const store = createPriceWindowStore();
    store.push("tok", 0, 1_000);
    store.push("tok", 1.2, 1_000);
    store.push("tok", NaN, 1_000);
    expect(store.history("tok")).toBeUndefined();
    store.push("tok", 0.5, 5_000);
    store.push("tok", 0.6, 4_000); // older than newest → dropped
    expect(store.history("tok")).toHaveLength(1);
  });

  it("evicts beyond the horizon but retains one carry-in sample", () => {
    const store = createPriceWindowStore();
    const t0 = 10 * HOUR;
    store.push("tok", 0.40, t0 - 2 * HOUR); // far past — evictable
    store.push("tok", 0.45, t0 - 90 * 60_000); // past horizon — becomes carry-in
    store.push("tok", 0.5, t0);
    const hist = store.history("tok")!;
    // The most recent at/before-horizon sample survives as carry-in.
    expect(hist[0]).toEqual({ t: t0 - 90 * 60_000, p: 0.45 });
    expect(hist[hist.length - 1]).toEqual({ t: t0, p: 0.5 });
    expect(hist).toHaveLength(2);
  });

  it("caps runaway buffers", () => {
    const store = createPriceWindowStore();
    for (let i = 0; i < 9_000; i++) store.push("tok", 0.5, 1_000_000 + i * 10);
    expect(store.history("tok")!.length).toBeLessThanOrEqual(7_200);
  });

  it("clear() wipes everything (reconnect fail-closed)", () => {
    const store = createPriceWindowStore();
    store.push("a", 0.5, 1_000);
    store.push("b", 0.5, 1_000);
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.history("a")).toBeUndefined();
  });

  it("drop() removes a single token", () => {
    const store = createPriceWindowStore();
    store.push("a", 0.5, 1_000);
    store.push("b", 0.5, 1_000);
    store.drop("a");
    expect(store.history("a")).toBeUndefined();
    expect(store.history("b")).toBeDefined();
  });
});
