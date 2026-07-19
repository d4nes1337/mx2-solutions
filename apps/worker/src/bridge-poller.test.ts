import { describe, expect, it, vi } from "vitest";
import { ok, err } from "@mx2/core";
import { createLogger } from "@mx2/observability";
import type { AuditStore, BridgeAddressRow, BridgeStore, PrivyWalletStore } from "@mx2/db";
import type { BridgeClient, DepositWalletRelayer, PolymarketError } from "@mx2/polymarket-client";
import { createBridgePoller } from "./bridge-poller.js";

const logger = createLogger({ name: "bridge-poller-test", level: "silent" });
const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const makeAddress = (over: Partial<BridgeAddressRow> = {}): BridgeAddressRow => ({
  id: "addr-1",
  walletAddress: "0xwallet",
  depositWalletAddress: "0xdeposit",
  kind: "deposit",
  addressType: "evm",
  address: "0xbridge",
  toChainId: null,
  toTokenAddress: null,
  recipientAddress: null,
  lastCheckedAt: null,
  createdAt: new Date(),
  ...over,
});

const address = makeAddress();

interface FakeWithdrawal {
  id: string;
  walletAddress: string;
  state: string;
  relayerTransactionId: string | null;
  createdAt: Date;
}

const makeDeps = (over: {
  getStatus?: BridgeClient["getStatus"];
  deposits?: { id: string; state: string; createdAt: Date }[];
  activeAddresses?: BridgeAddressRow[];
  pollableAddresses?: BridgeAddressRow[];
  withdrawals?: FakeWithdrawal[];
  relayer?: Partial<DepositWalletRelayer> & { enabled: boolean };
}) => {
  const audits: { action: string; subject: string | null; metadata?: unknown }[] = [];
  const checked: string[] = [];
  const upserts: unknown[][] = [];
  const advances: { id: string; state: string }[] = [];
  const withdrawals = over.withdrawals ?? [];
  const bridgeStore = {
    listPollableAddresses: async () => over.pollableAddresses ?? [address],
    listActivePollableAddresses: async () => over.activeAddresses ?? [],
    markAddressChecked: async (id: string) => {
      checked.push(id);
    },
    upsertDepositsFromStatus: async (_addr: unknown, txs: unknown[]) => {
      upserts.push(txs);
      return {
        changed: [
          {
            row: { id: "dep-1", state: "completed" } as never,
            previousState: "processing",
          },
        ],
      };
    },
    listDepositsByWallet: async () =>
      (over.deposits ?? [{ id: "dep-1", state: "completed", createdAt: new Date() }]) as never[],
    updateWithdrawalsFromStatus: async () => ({ changed: [] }),
    listWithdrawalsByStates: async (states: readonly string[]) =>
      withdrawals.filter((w) => states.includes(w.state)) as never[],
    advanceWithdrawalState: async (id: string, state: string) => {
      advances.push({ id, state });
      const row = withdrawals.find((w) => w.id === id);
      if (!row) return null;
      row.state = state;
      return row as never;
    },
  } as unknown as BridgeStore;
  const bridgeClient = {
    getStatus:
      over.getStatus ??
      (async () =>
        ok({
          transactions: [
            { fromChainId: "8453", status: "COMPLETED", txHash: "0xabc", createdTimeMs: 1 },
          ],
        })),
  } as unknown as BridgeClient;
  const auditStore: AuditStore = {
    emit: async (e) => {
      audits.push({ action: e.action, subject: e.subject ?? null, metadata: e.metadata });
      return {
        id: "a",
        actor: e.actor,
        action: e.action,
        subject: e.subject ?? null,
        metadata: e.metadata,
        createdAt: new Date(),
      };
    },
    recent: async () => [],
    forActor: async () => [],
    forSubject: async () => [],
  };
  const privyWallets = {
    find: async () => ({
      ownerWallet: "0xwallet",
      privyWalletId: "pw-1",
      embeddedAddress: "0xembedded",
      policyId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as unknown as PrivyWalletStore;
  return {
    bridgeStore,
    bridgeClient,
    auditStore,
    privyWallets,
    audits,
    checked,
    upserts,
    advances,
    withdrawals,
  };
};

const makeRelayer = (over: Partial<DepositWalletRelayer> = {}): DepositWalletRelayer =>
  ({
    enabled: true,
    getTransactionState: async () => ok({ state: "STATE_MINED", transactionHash: "0xph" }),
    ...over,
  }) as unknown as DepositWalletRelayer;

describe("bridge poller", () => {
  it("polls addresses, upserts deposits, audits transitions, marks checked", async () => {
    const deps = makeDeps({});
    const poller = createBridgePoller({ logger, ...deps });
    await poller.tick();
    expect(deps.checked).toEqual(["addr-1"]);
    expect(deps.upserts).toHaveLength(1);
    expect(
      deps.audits.some(
        (a) =>
          a.action === "wallet.bridge.deposit_state_changed" &&
          a.subject === "bridge_deposit:dep-1",
      ),
    ).toBe(true);
  });

  it("keeps going when the status API errors (retry next tick)", async () => {
    const deps = makeDeps({ getStatus: async () => err(upstreamErr) });
    const poller = createBridgePoller({ logger, ...deps });
    await poller.tick(); // must not throw
    expect(deps.checked).toEqual(["addr-1"]); // still marks checked → backoff works
    expect(deps.upserts).toHaveLength(0);
  });

  it("flags deposits stuck non-terminal past the reconciliation window, once", async () => {
    const stuck = {
      id: "dep-stuck",
      state: "processing",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    };
    const deps = makeDeps({ deposits: [stuck] });
    const poller = createBridgePoller({ logger, ...deps });
    await poller.tick();
    await poller.tick();
    const flags = deps.audits.filter((a) => a.action === "wallet.bridge.reconciliation_flagged");
    expect(flags).toHaveLength(1);
    expect(flags[0]!.subject).toBe("bridge_deposit:dep-stuck");
  });

  it("start/stop drives ticks on the interval without overlap", async () => {
    vi.useFakeTimers();
    const deps = makeDeps({});
    const poller = createBridgePoller({ logger, ...deps, intervalMs: 1_000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(3_100);
    poller.stop();
    vi.useRealTimers();
    expect(deps.checked.length).toBe(3);
  });

  it("active addresses poll every tick; the full sweep only on the slow interval", async () => {
    vi.useFakeTimers();
    const activeAddr = makeAddress({ id: "addr-active", address: "0xactive" });
    const idleAddr = makeAddress({ id: "addr-idle", address: "0xidle" });
    const deps = makeDeps({ activeAddresses: [activeAddr], pollableAddresses: [idleAddr] });
    const poller = createBridgePoller({
      logger,
      ...deps,
      activeIntervalMs: 1_000,
      intervalMs: 3_000,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(3_100);
    poller.stop();
    vi.useRealTimers();
    // 3 ticks: the active address is checked on every one; the idle sweep ran
    // only on the first tick (next would be due at +3s from it).
    expect(deps.checked.filter((id) => id === "addr-active")).toHaveLength(3);
    expect(deps.checked.filter((id) => id === "addr-idle")).toHaveLength(1);
  });

  it("does not double-process an address present in both passes", async () => {
    const deps = makeDeps({ activeAddresses: [address], pollableAddresses: [address] });
    const poller = createBridgePoller({ logger, ...deps });
    await poller.tick();
    expect(deps.checked).toEqual(["addr-1"]);
  });

  describe("withdrawal relayer pass", () => {
    const submittedRow = (): FakeWithdrawal => ({
      id: "bw-1",
      walletAddress: "0xwallet",
      state: "polygon_submitted",
      relayerTransactionId: "rtx-1",
      createdAt: new Date(),
    });

    it("advances polygon_submitted → polygon_confirmed on STATE_MINED, with audit", async () => {
      const deps = makeDeps({ withdrawals: [submittedRow()] });
      const poller = createBridgePoller({
        logger,
        ...deps,
        depositWalletRelayer: makeRelayer(),
      });
      await poller.tick();
      expect(deps.advances).toEqual([{ id: "bw-1", state: "polygon_confirmed" }]);
      const audit = deps.audits.find(
        (a) =>
          a.action === "wallet.bridge.withdraw_state_changed" &&
          a.subject === "bridge_withdrawal:bw-1",
      );
      expect(audit).toBeDefined();
      expect(audit!.metadata).toMatchObject({
        from: "polygon_submitted",
        to: "polygon_confirmed",
        source: "relayer",
        relayerTransactionId: "rtx-1",
      });
    });

    it("marks failed_polygon on STATE_FAILED", async () => {
      const deps = makeDeps({ withdrawals: [submittedRow()] });
      const poller = createBridgePoller({
        logger,
        ...deps,
        depositWalletRelayer: makeRelayer({
          getTransactionState: async () => ok({ state: "STATE_FAILED" }),
        }),
      });
      await poller.tick();
      expect(deps.advances).toEqual([{ id: "bw-1", state: "failed_polygon" }]);
      expect(deps.withdrawals[0]!.state).toBe("failed_polygon");
    });

    it("leaves rows alone on non-final relayer states", async () => {
      const deps = makeDeps({ withdrawals: [submittedRow()] });
      const poller = createBridgePoller({
        logger,
        ...deps,
        depositWalletRelayer: makeRelayer({
          getTransactionState: async () => ok({ state: "STATE_EXECUTED" }),
        }),
      });
      await poller.tick();
      expect(deps.advances).toHaveLength(0);
      expect(deps.withdrawals[0]!.state).toBe("polygon_submitted");
    });

    it("skips rows without a relayer transaction id", async () => {
      const row = { ...submittedRow(), relayerTransactionId: null };
      let relayerCalls = 0;
      const deps = makeDeps({ withdrawals: [row] });
      const poller = createBridgePoller({
        logger,
        ...deps,
        depositWalletRelayer: makeRelayer({
          getTransactionState: async () => {
            relayerCalls += 1;
            return ok({ state: "STATE_MINED" });
          },
        }),
      });
      await poller.tick();
      expect(relayerCalls).toBe(0);
    });

    it("emits no audit when the store reports nothing moved (concurrent writer won)", async () => {
      const deps = makeDeps({ withdrawals: [submittedRow()] });
      // Simulate the bridge status pass having already moved the row on.
      deps.bridgeStore.advanceWithdrawalState = async () => null;
      const poller = createBridgePoller({
        logger,
        ...deps,
        depositWalletRelayer: makeRelayer(),
      });
      await poller.tick();
      expect(
        deps.audits.filter((a) => a.action === "wallet.bridge.withdraw_state_changed"),
      ).toHaveLength(0);
    });

    it("is skipped entirely when no relayer is wired", async () => {
      const deps = makeDeps({ withdrawals: [submittedRow()] });
      const poller = createBridgePoller({ logger, ...deps });
      await poller.tick();
      expect(deps.advances).toHaveLength(0);
    });
  });

  it("flags withdrawals stuck non-terminal past the reconciliation window, once", async () => {
    const stuck: FakeWithdrawal = {
      id: "bw-stuck",
      walletAddress: "0xwallet",
      state: "bridging",
      relayerTransactionId: "rtx-2",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    };
    const deps = makeDeps({ withdrawals: [stuck] });
    const poller = createBridgePoller({ logger, ...deps });
    await poller.tick();
    await poller.tick();
    const flags = deps.audits.filter(
      (a) =>
        a.action === "wallet.bridge.reconciliation_flagged" &&
        a.subject === "bridge_withdrawal:bw-stuck",
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.metadata).toMatchObject({ state: "bridging" });
  });
});
