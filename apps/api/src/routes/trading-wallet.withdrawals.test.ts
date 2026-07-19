import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { ok, err } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import type {
  AuditStore,
  BridgeAddressRow,
  BridgeStore,
  BridgeWithdrawalRow,
  PrivyWalletStore,
  SessionStore,
  WalletWithdrawalRow,
  WithdrawalStore,
} from "@mx2/db";
import { WITHDRAWAL_TERMINAL, BRIDGE_WITHDRAWAL_STATE_RANK } from "@mx2/db";
import type { BridgeClient, DepositWalletRelayer, GeoblockClient } from "@mx2/polymarket-client";
import { registerTradingWalletRoutes, type TradingWalletRoutesDeps } from "./trading-wallet.js";

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const COOKIE = "mx2_session=tok";

const sessions: SessionStore = {
  create: async () => {
    throw new Error("no");
  },
  findByTokenHash: async () => ({
    id: "s1",
    userWallet: WALLET,
    tokenHash: "h",
    expiresAt: new Date(Date.now() + 1_000_000),
    scope: null,
    createdAt: new Date(),
    revokedAt: null,
  }),
  revoke: async () => {},
};

const geoblockClient: GeoblockClient = {
  check: async () =>
    ok({ status: "allowed" as const, country: "SE", region: null, ip: "1.2.3.4", blocked: false }),
};

const makeAudits = () => {
  const audits: { action: string; subject: string | null; metadata?: unknown }[] = [];
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
  return { audits, auditStore };
};

const makeBridgeWithdrawal = (over: Partial<BridgeWithdrawalRow> = {}): BridgeWithdrawalRow =>
  ({
    id: "bw-1",
    walletAddress: WALLET,
    depositWalletAddress: "0xdeposit",
    destinationAddress: WALLET,
    toChainId: "8453",
    toTokenAddress: "0xusdc",
    bridgeAddressId: "hop-1",
    amountUsd: "25",
    quoteId: null,
    estToTokenBaseUnit: null,
    state: "polygon_submitted",
    relayerTransactionId: "rtx-1",
    polygonTxHash: null,
    bridgeTxHash: null,
    error: null,
    idempotencyKey: "idem-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as BridgeWithdrawalRow;

const makeHopAddress = (over: Partial<BridgeAddressRow> = {}): BridgeAddressRow => ({
  id: "hop-1",
  walletAddress: WALLET,
  depositWalletAddress: "0xdeposit",
  kind: "withdrawal",
  addressType: "evm",
  address: "0xhop",
  toChainId: "8453",
  toTokenAddress: "0xusdc",
  recipientAddress: WALLET,
  lastCheckedAt: null,
  createdAt: new Date(),
  ...over,
});

const buildApp = async (opts: {
  bridgeWithdrawals?: BridgeWithdrawalRow[];
  hopAddresses?: BridgeAddressRow[];
  directRows?: WalletWithdrawalRow[];
  relayerState?: { state: string; transactionHash?: string };
  relayerEnabled?: boolean;
  relayerError?: boolean;
  getStatus?: BridgeClient["getStatus"];
}): Promise<{
  app: FastifyInstance;
  audits: { action: string; subject: string | null; metadata?: unknown }[];
  bridgeRows: BridgeWithdrawalRow[];
  hopAddresses: BridgeAddressRow[];
  relayerCalls: string[];
  statusCalls: string[];
}> => {
  const config = loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" });
  const { audits, auditStore } = makeAudits();
  const bridgeRows = opts.bridgeWithdrawals ?? [];
  const hopAddresses = opts.hopAddresses ?? [];
  const directRows = opts.directRows ?? [];
  const relayerCalls: string[] = [];
  const statusCalls: string[] = [];

  const withdrawals = {
    create: async () => null,
    updateState: async (id: string, update: { state: string; transactionHash?: string }) => {
      const row = directRows.find((r) => r.id === id);
      if (row) {
        row.state = update.state;
        if (update.transactionHash) row.transactionHash = update.transactionHash;
      }
    },
    findByIdempotencyKey: async () => null,
    listByWallet: async () => directRows,
  } as unknown as WithdrawalStore;

  const bridgeStore = {
    listWithdrawalsByWallet: async () => bridgeRows,
    listAddresses: async (_w: string, kind?: string) =>
      hopAddresses.filter((a) => !kind || a.kind === kind),
    markAddressChecked: async (id: string) => {
      const row = hopAddresses.find((a) => a.id === id);
      if (row) row.lastCheckedAt = new Date();
    },
    advanceWithdrawalState: async (
      id: string,
      state: string,
      patch?: Partial<BridgeWithdrawalRow>,
    ) => {
      const row = bridgeRows.find((r) => r.id === id);
      if (!row || WITHDRAWAL_TERMINAL.has(row.state)) return null;
      if (!state.startsWith("failed")) {
        const next = BRIDGE_WITHDRAWAL_STATE_RANK[state];
        const current = BRIDGE_WITHDRAWAL_STATE_RANK[row.state] ?? 0;
        if (next === undefined || next <= current) return null;
      }
      Object.assign(row, patch ?? {}, { state });
      return row;
    },
    updateWithdrawalsFromStatus: async (
      address: BridgeAddressRow,
      transactions: readonly { status: string; txHash?: string | null }[],
    ) => {
      const changed: { row: BridgeWithdrawalRow; previousState: string }[] = [];
      const completedTx = transactions.find((t) => t.status === "COMPLETED");
      for (const row of bridgeRows) {
        if (row.bridgeAddressId !== address.id || WITHDRAWAL_TERMINAL.has(row.state)) continue;
        if (completedTx) {
          const previousState = row.state;
          row.state = "completed";
          row.bridgeTxHash = completedTx.txHash ?? null;
          changed.push({ row, previousState });
        }
      }
      return { changed };
    },
  } as unknown as BridgeStore;

  const depositWalletRelayer = {
    enabled: opts.relayerEnabled !== false,
    getTransactionState: async (_owner: unknown, transactionId: string) => {
      relayerCalls.push(transactionId);
      if (opts.relayerError) return err({ code: "RELAYER_UPSTREAM_ERROR", message: "x" });
      return ok(opts.relayerState ?? { state: "STATE_CONFIRMED", transactionHash: "0xpoly" });
    },
  } as unknown as DepositWalletRelayer;

  const bridgeClient = {
    getStatus:
      opts.getStatus ??
      (async (address: string) => {
        statusCalls.push(address);
        return ok({
          transactions: [{ status: "COMPLETED", txHash: "0xbridged" }],
        });
      }),
  } as unknown as BridgeClient;

  const privyWallets = {
    find: async () => ({
      ownerWallet: WALLET,
      privyWalletId: "pw",
      embeddedAddress: "0x1212121212121212121212121212121212121212",
      policyId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as unknown as PrivyWalletStore;

  const app = Fastify();
  await app.register(fastifyCookie);
  registerTradingWalletRoutes(app, {
    config,
    sessions,
    auditStore,
    tradingSigner: {} as never,
    privyWallets,
    tradingAccounts: { listByOwner: async () => [] } as never,
    delegations: {} as never,
    depositWalletRelayer,
    withdrawals,
    bridgeClient,
    bridgeStore,
    geoblockClient,
    allowanceReader: null,
  } as TradingWalletRoutesDeps);
  return { app, audits, bridgeRows, hopAddresses, relayerCalls, statusCalls };
};

const getWithdrawals = async (app: FastifyInstance) => {
  const res = await app.inject({
    method: "GET",
    url: "/api/trading-wallet/withdrawals",
    headers: { cookie: COOKIE },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    withdrawals: { id: string; state: string; transactionHash: string | null }[];
    bridgeWithdrawals: {
      id: string;
      state: string;
      polygonTxHash: string | null;
      bridgeTxHash: string | null;
    }[];
  };
};

describe("GET /api/trading-wallet/withdrawals — bridge Polygon leg refresh", () => {
  it("advances polygon_submitted → polygon_confirmed from the relayer, with audit", async () => {
    const { app, audits, relayerCalls } = await buildApp({
      bridgeWithdrawals: [makeBridgeWithdrawal()],
      hopAddresses: [makeHopAddress()],
      // Hop status has nothing yet — only the relayer knows the leg mined.
      getStatus: async () => ok({ transactions: [] }),
    });
    const body = await getWithdrawals(app);
    expect(relayerCalls).toEqual(["rtx-1"]);
    expect(body.bridgeWithdrawals[0]!.state).toBe("polygon_confirmed");
    expect(body.bridgeWithdrawals[0]!.polygonTxHash).toBe("0xpoly");
    const audit = audits.find(
      (a) =>
        a.action === "wallet.bridge.withdraw_state_changed" &&
        a.subject === "bridge_withdrawal:bw-1",
    );
    expect(audit).toBeDefined();
    expect(audit!.metadata).toMatchObject({
      from: "polygon_submitted",
      to: "polygon_confirmed",
      source: "relayer",
    });
    await app.close();
  });

  it("marks failed_polygon when the relayer reports the leg failed", async () => {
    const { app, bridgeRows } = await buildApp({
      bridgeWithdrawals: [makeBridgeWithdrawal()],
      relayerState: { state: "STATE_FAILED" },
      getStatus: async () => ok({ transactions: [] }),
    });
    const body = await getWithdrawals(app);
    expect(body.bridgeWithdrawals[0]!.state).toBe("failed_polygon");
    expect(bridgeRows[0]!.error).toBe("STATE_FAILED");
    await app.close();
  });

  it("pulls hop-address status for in-transit rows, bounded by lastCheckedAt", async () => {
    const { app, statusCalls } = await buildApp({
      bridgeWithdrawals: [makeBridgeWithdrawal({ state: "bridging" })],
      hopAddresses: [makeHopAddress()],
    });
    const body = await getWithdrawals(app);
    expect(statusCalls).toEqual(["0xhop"]);
    expect(body.bridgeWithdrawals[0]!.state).toBe("completed");
    expect(body.bridgeWithdrawals[0]!.bridgeTxHash).toBe("0xbridged");

    // Immediately again: address was just checked → no second Bridge call.
    await getWithdrawals(app);
    expect(statusCalls).toHaveLength(1);
    await app.close();
  });

  it("does not touch the Bridge for rows still on the Polygon leg", async () => {
    const { app, statusCalls } = await buildApp({
      bridgeWithdrawals: [makeBridgeWithdrawal()],
      hopAddresses: [makeHopAddress()],
      relayerState: { state: "STATE_NEW" },
    });
    const body = await getWithdrawals(app);
    expect(statusCalls).toHaveLength(0);
    expect(body.bridgeWithdrawals[0]!.state).toBe("polygon_submitted");
    await app.close();
  });

  it("keeps stored state when the relayer errors (fail-soft)", async () => {
    const { app } = await buildApp({
      bridgeWithdrawals: [makeBridgeWithdrawal()],
      relayerError: true,
      getStatus: async () => ok({ transactions: [] }),
    });
    const body = await getWithdrawals(app);
    expect(body.bridgeWithdrawals[0]!.state).toBe("polygon_submitted");
    await app.close();
  });

  it("skips all relayer work when the relayer is disabled", async () => {
    const { app, relayerCalls } = await buildApp({
      bridgeWithdrawals: [makeBridgeWithdrawal()],
      relayerEnabled: false,
      getStatus: async () => ok({ transactions: [] }),
    });
    const body = await getWithdrawals(app);
    expect(relayerCalls).toHaveLength(0);
    expect(body.bridgeWithdrawals[0]!.state).toBe("polygon_submitted");
    await app.close();
  });
});
