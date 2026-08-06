import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "@mx2/observability";
import { ok, err } from "@mx2/core";
import type { GammaMarket } from "@mx2/polymarket-client";
import { createMarketStatusPoller } from "./market-status-poller.js";

const logger = createLogger({ name: "status-poller-test", level: "silent" });

const gammaMarket = (over: Partial<GammaMarket>): GammaMarket =>
  ({
    id: "m1",
    question: "q",
    conditionId: "cond-1",
    active: true,
    closed: false,
    ...over,
  }) as GammaMarket;

describe("market status poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const run = (market: GammaMarket | null, fail = false) => {
    const statuses: { tokenId: string; status: string }[] = [];
    const stamps: { tokenId: string; status: string | null }[] = [];
    const poller = createMarketStatusPoller({
      logger,
      gammaClient: {
        findMarket: async () =>
          fail ? err({ kind: "network", message: "down" } as never) : ok(market),
      },
      marketSnapshots: {
        setMarketStatus: async (tokenId: string, status: string | null) => {
          stamps.push({ tokenId, status });
        },
      },
      listWatched: () => [
        { tokenId: "tok-up", conditionId: "cond-1" },
        { tokenId: "tok-down", conditionId: "cond-1" },
      ],
      onMarketStatus: (tokenId, status) => statuses.push({ tokenId, status }),
      intervalMs: 1_000,
    });
    return { poller, statuses, stamps };
  };

  it("maps closed → resolved for every token of the condition, and stamps once", async () => {
    const { poller, statuses, stamps } = run(gammaMarket({ closed: true }));
    poller.start();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(statuses).toEqual([
      { tokenId: "tok-up", status: "resolved" },
      { tokenId: "tok-down", status: "resolved" },
    ]);
    expect(stamps).toEqual([
      { tokenId: "tok-up", status: "resolved" },
      { tokenId: "tok-down", status: "resolved" },
    ]);
    // Second pass: evaluator is re-notified (it dedupes), but no re-stamp.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stamps).toHaveLength(2);
    poller.stop();
  });

  it("maps active:false → paused, open otherwise; upstream failure changes nothing", async () => {
    const paused = run(gammaMarket({ active: false }));
    paused.poller.start();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(paused.statuses[0]).toEqual({ tokenId: "tok-up", status: "paused" });
    paused.poller.stop();

    const open = run(gammaMarket({}));
    open.poller.start();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(open.statuses[0]).toEqual({ tokenId: "tok-up", status: "open" });
    expect(open.stamps).toHaveLength(0); // open is the default — never stamped
    open.poller.stop();

    const failing = run(null, true);
    failing.poller.start();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(failing.statuses).toHaveLength(0); // fail open: unknown ≠ closed
    expect(failing.stamps).toHaveLength(0);
    failing.poller.stop();
  });
});
