import { describe, expect, it } from "vitest";
import { ok, err } from "@mx2/core";
import type { Logger } from "@mx2/observability";
import type { VolumeStore, VolumeSyncTarget } from "@mx2/db";
import type { Activity, DataClient } from "@mx2/polymarket-client";
import { createVolumeSyncLoop, newTradesFrom } from "./volume-sync.js";

const WALLET = `0x${"a".repeat(40)}`;

const trade = (over: Partial<Activity> = {}): Activity => ({
  proxyWallet: "0xproxy",
  timestamp: 1_753_600_000,
  type: "TRADE",
  size: 10,
  usdcSize: 6.5,
  price: 0.65,
  ...over,
});

const silentLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Logger;

describe("newTradesFrom", () => {
  it("keeps only TRADE rows strictly newer than the cursor", () => {
    const rows = [
      trade({ timestamp: 300 }),
      trade({ timestamp: 200, type: "REDEEM" }),
      trade({ timestamp: 200 }),
      trade({ timestamp: 100 }),
    ];
    expect(newTradesFrom(rows, 200)).toEqual([{ timestamp: 300, usdcSize: 6.5 }]);
  });
});

const makeStore = (targets: VolumeSyncTarget[]) => {
  const applied: { walletAddress: string; proxyWallet: string; trades: unknown[] }[] = [];
  const touched: string[] = [];
  const store: VolumeStore = {
    listSyncTargets: async () => targets,
    applyTrades: async (opts) => {
      applied.push(opts);
    },
    touchSynced: async (wallet) => {
      touched.push(wallet);
    },
    statsFor: async () => null,
    referralLeaderboard: async () => [],
    attributedForCodes: async () => [],
  };
  return { store, applied, touched };
};

const clientReturning = (pages: Activity[][] | "error") => {
  const calls: { offset?: number }[] = [];
  const dataClient = {
    getActivity: async (params: { offset?: number }) => {
      calls.push(params);
      if (pages === "error") return err({ kind: "http", message: "boom" });
      return ok(pages[calls.length - 1] ?? []);
    },
  } as unknown as DataClient;
  return { dataClient, calls };
};

describe("createVolumeSyncLoop.runOnce", () => {
  it("applies fresh trades and records the sync", async () => {
    const { store, applied } = makeStore([{ walletAddress: WALLET, lastSyncedTimestamp: 100 }]);
    const { dataClient } = clientReturning([[trade({ timestamp: 300 }), trade({ timestamp: 90 })]]);
    const loop = createVolumeSyncLoop({
      logger: silentLogger,
      volumeStore: store,
      dataClient,
      staggerMs: 0,
    });
    await loop.runOnce();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.trades).toEqual([{ timestamp: 300, usdcSize: 6.5 }]);
    // Proxy wallet is derived, never user input.
    expect(applied[0]!.proxyWallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("touches syncedAt when nothing new arrived", async () => {
    const { store, applied, touched } = makeStore([
      { walletAddress: WALLET, lastSyncedTimestamp: 400 },
    ]);
    const { dataClient } = clientReturning([[trade({ timestamp: 300 })]]);
    const loop = createVolumeSyncLoop({
      logger: silentLogger,
      volumeStore: store,
      dataClient,
      staggerMs: 0,
    });
    await loop.runOnce();
    expect(applied).toHaveLength(0);
    expect(touched).toEqual([WALLET]);
  });

  it("paginates until the cursor boundary", async () => {
    const pageSize = 2;
    const { store, applied } = makeStore([{ walletAddress: WALLET, lastSyncedTimestamp: 100 }]);
    const { dataClient, calls } = clientReturning([
      [trade({ timestamp: 500 }), trade({ timestamp: 400 })],
      [trade({ timestamp: 300 }), trade({ timestamp: 50 })],
    ]);
    const loop = createVolumeSyncLoop({
      logger: silentLogger,
      volumeStore: store,
      dataClient,
      staggerMs: 0,
      pageLimit: pageSize,
    });
    await loop.runOnce();
    expect(calls).toHaveLength(2);
    expect(applied[0]!.trades).toHaveLength(3);
  });

  it("fails soft: one wallet's upstream error never aborts the sweep", async () => {
    const otherWallet = `0x${"b".repeat(40)}`;
    const { store, touched } = makeStore([
      { walletAddress: WALLET, lastSyncedTimestamp: 0 },
      { walletAddress: otherWallet, lastSyncedTimestamp: 0 },
    ]);
    let call = 0;
    const dataClient = {
      getActivity: async () => {
        call++;
        return call === 1 ? err({ kind: "http", message: "boom" }) : ok([]);
      },
    } as unknown as DataClient;
    const loop = createVolumeSyncLoop({
      logger: silentLogger,
      volumeStore: store,
      dataClient,
      staggerMs: 0,
    });
    await loop.runOnce();
    // First wallet errored (skipped), second still synced.
    expect(touched).toEqual([otherWallet]);
  });
});
