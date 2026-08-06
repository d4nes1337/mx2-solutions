import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "@mx2/observability";
import type { PriceSample } from "@mx2/rules";
import { createPriceSeeder } from "./price-seeder.js";
import { createPriceWindowStore } from "./price-window.js";

const logger = createLogger({ name: "seeder-test", level: "silent" });

describe("price seeder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:15:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sample = (): PriceSample[] => [{ t: Date.now() - 120_000, p: 0.55 }];

  it("merges fetched history and rate-limits repeat seeds", async () => {
    const priceWindows = createPriceWindowStore();
    let fetches = 0;
    const seeder = createPriceSeeder({
      logger,
      priceWindows,
      fetchPriceHistory: async () => {
        fetches++;
        return sample();
      },
    });
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(1);
    expect(priceWindows.history("tok")).toHaveLength(1);
    // Within the reseed interval → skipped.
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(1);
    // force (reconnect heal) bypasses the rate limit.
    await seeder.seedToken("tok", 60_000, { force: true });
    expect(fetches).toBe(2);
    // After the interval → allowed again.
    await vi.advanceTimersByTimeAsync(31_000);
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(3);
  });

  it("reseeds immediately when the buffer was dropped, despite the rate limit", async () => {
    const priceWindows = createPriceWindowStore();
    let fetches = 0;
    const seeder = createPriceSeeder({
      logger,
      priceWindows,
      fetchPriceHistory: async () => {
        fetches++;
        return sample();
      },
    });
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(1);
    // Crash-recovery / pause-resume drops the buffer, then re-adds the rule
    // well inside the 30s rate limit — the reseed must NOT be skipped.
    priceWindows.drop("tok");
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(2);
    expect(priceWindows.history("tok")).toHaveLength(1);
  });

  it("single-flights concurrent seeds for the same token", async () => {
    const priceWindows = createPriceWindowStore();
    let fetches = 0;
    let release: (() => void) | null = null;
    const seeder = createPriceSeeder({
      logger,
      priceWindows,
      fetchPriceHistory: async () => {
        fetches++;
        await new Promise<void>((r) => {
          release = r;
        });
        return sample();
      },
    });
    const first = seeder.seedToken("tok", 60_000);
    const second = seeder.seedToken("tok", 60_000, { force: true });
    expect(fetches).toBe(1);
    release!();
    await Promise.all([first, second]);
    expect(fetches).toBe(1);
  });

  it("backs off after failures and never rejects", async () => {
    const priceWindows = createPriceWindowStore();
    let fetches = 0;
    const seeder = createPriceSeeder({
      logger,
      priceWindows,
      fetchPriceHistory: async () => {
        fetches++;
        throw new Error("upstream down");
      },
    });
    await expect(seeder.seedToken("tok", 60_000)).resolves.toBeUndefined();
    expect(fetches).toBe(1);
    // Inside the backoff → skipped.
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(16_000);
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(2);
  });

  it("null history (upstream error result) also backs off", async () => {
    const priceWindows = createPriceWindowStore();
    let fetches = 0;
    const seeder = createPriceSeeder({
      logger,
      priceWindows,
      fetchPriceHistory: async () => {
        fetches++;
        return null;
      },
    });
    await seeder.seedToken("tok", 60_000);
    await seeder.seedToken("tok", 60_000);
    expect(fetches).toBe(1);
    expect(priceWindows.history("tok")).toBeUndefined();
  });
});
