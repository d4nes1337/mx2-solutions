import { describe, expect, it, vi } from "vitest";
import { ok, err } from "@mx2/core";
import { createLogger } from "@mx2/observability";
import type { AuditStore, BridgeAddressRow, BridgeStore } from "@mx2/db";
import type { BridgeClient, PolymarketError } from "@mx2/polymarket-client";
import { createBridgePoller } from "./bridge-poller.js";

const logger = createLogger({ name: "bridge-poller-test", level: "silent" });
const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const address: BridgeAddressRow = {
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
};

const makeDeps = (over: {
  getStatus?: BridgeClient["getStatus"];
  deposits?: { id: string; state: string; createdAt: Date }[];
}) => {
  const audits: { action: string; subject: string | null }[] = [];
  const checked: string[] = [];
  const upserts: unknown[][] = [];
  const bridgeStore = {
    listPollableAddresses: async () => [address],
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
      audits.push({ action: e.action, subject: e.subject ?? null });
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
  };
  return { bridgeStore, bridgeClient, auditStore, audits, checked, upserts };
};

describe("bridge poller", () => {
  it("polls addresses, upserts deposits, audits transitions, marks checked", async () => {
    const deps = makeDeps({});
    const poller = createBridgePoller({ logger, ...deps });
    await poller.tick();
    expect(deps.checked).toEqual(["addr-1"]);
    expect(deps.upserts).toHaveLength(1);
    expect(
      deps.audits.some(
        (a) => a.action === "wallet.bridge.deposit_state_changed" && a.subject === "bridge_deposit:dep-1",
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
    const stuck = { id: "dep-stuck", state: "processing", createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) };
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
});
