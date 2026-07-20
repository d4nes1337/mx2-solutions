import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { ok, err } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import type {
  AuditStore,
  BridgeAddressRow,
  BridgeStore,
  PrivyWalletStore,
  SessionStore,
  TradingAccountStore,
} from "@mx2/db";
import {
  PUSD_ADDRESS,
  type BridgeClient,
  type GeoblockClient,
  type PolymarketError,
} from "@mx2/polymarket-client";
import { registerFundsRoutes } from "./funds.js";

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const DEPOSIT_WALLET = "0x9999999999999999999999999999999999999999";
const COOKIE = "mx2_session=tok";
const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

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

const auditStore: AuditStore = {
  emit: async (e) => ({
    id: "a",
    actor: e.actor,
    action: e.action,
    subject: e.subject ?? null,
    metadata: e.metadata,
    createdAt: new Date(),
  }),
  recent: async () => [],
  forActor: async () => [],
  forSubject: async () => [],
};

const geoblockClient: GeoblockClient = {
  check: async () =>
    ok({ status: "allowed" as const, country: "SE", region: null, ip: "1.2.3.4", blocked: false }),
};

/** Minimal in-memory BridgeStore. */
const makeBridgeStore = (): BridgeStore & { addresses: BridgeAddressRow[] } => {
  const addresses: BridgeAddressRow[] = [];
  const deposits: {
    id: string;
    walletAddress: string;
    bridgeAddressId: string;
    fromChainId: string;
    fromTokenAddress: string;
    fromAmountBaseUnit: string;
    state: string;
    providerStatus: string;
    txHash: string | null;
    providerCreatedTimeMs: number;
    raw: unknown;
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  const RANK: Record<string, number> = {
    detected: 0,
    processing: 1,
    origin_confirmed: 2,
    submitted: 3,
    completed: 4,
    failed: 4,
  };
  const stateFor = (s: string) =>
    (
      ({
        DEPOSIT_DETECTED: "detected",
        PROCESSING: "processing",
        ORIGIN_TX_CONFIRMED: "origin_confirmed",
        SUBMITTED: "submitted",
        COMPLETED: "completed",
        FAILED: "failed",
      }) as Record<string, string>
    )[s] ?? "processing";
  return {
    addresses,
    saveAddress: async (row) => {
      const existing = addresses.find(
        (a) =>
          a.walletAddress === row.walletAddress &&
          a.kind === (row.kind ?? "deposit") &&
          a.address === row.address,
      );
      if (existing) return existing;
      const saved: BridgeAddressRow = {
        id: `addr-${addresses.length + 1}`,
        walletAddress: row.walletAddress,
        depositWalletAddress: row.depositWalletAddress,
        kind: row.kind ?? "deposit",
        addressType: row.addressType,
        address: row.address,
        toChainId: row.toChainId ?? null,
        toTokenAddress: row.toTokenAddress ?? null,
        recipientAddress: row.recipientAddress ?? null,
        lastCheckedAt: null,
        createdAt: new Date(),
      };
      addresses.push(saved);
      return saved;
    },
    listAddresses: async (w, kind) =>
      addresses.filter((a) => a.walletAddress === w && (!kind || a.kind === kind)),
    listPollableAddresses: async () => [],
    listActivePollableAddresses: async () => [],
    markAddressChecked: async () => {},
    upsertDepositsFromStatus: async (address, transactions) => {
      const changed: { row: never; previousState: string | null }[] = [];
      for (const tx of transactions) {
        const state = stateFor(tx.status);
        const key = `${address.id}:${tx.fromChainId ?? ""}:${tx.fromTokenAddress ?? ""}:${tx.fromAmountBaseUnit ?? ""}:${tx.createdTimeMs ?? 0}`;
        const existing = deposits.find(
          (d) =>
            `${d.bridgeAddressId}:${d.fromChainId}:${d.fromTokenAddress}:${d.fromAmountBaseUnit}:${d.providerCreatedTimeMs}` ===
            key,
        );
        if (!existing) {
          const row = {
            id: `dep-${deposits.length + 1}`,
            walletAddress: address.walletAddress,
            bridgeAddressId: address.id,
            fromChainId: tx.fromChainId ?? "",
            fromTokenAddress: tx.fromTokenAddress ?? "",
            fromAmountBaseUnit: tx.fromAmountBaseUnit ?? "",
            state,
            providerStatus: tx.status,
            txHash: tx.txHash ?? null,
            providerCreatedTimeMs: tx.createdTimeMs ?? 0,
            raw: tx.raw ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          deposits.push(row);
          changed.push({ row: row as never, previousState: null });
          continue;
        }
        if ((RANK[state] ?? 1) > (RANK[existing.state] ?? 0)) {
          const prev = existing.state;
          existing.state = state;
          existing.providerStatus = tx.status;
          changed.push({ row: existing as never, previousState: prev });
        }
      }
      return { changed };
    },
    listDepositsByWallet: async (w) => deposits.filter((d) => d.walletAddress === w) as never[],
    createWithdrawal: async () => null,
    findWithdrawalByIdempotencyKey: async () => null,
    listWithdrawalsByWallet: async () => [],
    updateWithdrawalState: async () => null,
    updateWithdrawalsFromStatus: async () => ({ changed: [] }),
    advanceWithdrawalState: async () => null,
    listWithdrawalsByStates: async () => [],
    dismissDeposit: async () => null,
    listNonTerminalDeposits: async () => [],
    expireStaleDeposits: async () => [],
    completeDepositFromChain: async () => null,
  };
};

const makeBridgeClient = (over: Partial<BridgeClient> = {}): BridgeClient => ({
  getSupportedAssets: async () =>
    ok({
      supportedAssets: [
        {
          chainId: "8453",
          chainName: "Base",
          token: {
            name: "USDC",
            symbol: "USDC",
            address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            decimals: 6,
          },
          minCheckoutUsd: 2,
        },
      ],
    }),
  createDepositAddresses: async () => ok({ evm: "0x3333333333333333333333333333333333333333" }),
  getQuote: async () =>
    ok({
      quoteId: "q-1",
      estCheckoutTimeMs: 45_000,
      estOutputUsd: 4.95,
      estFeeBreakdown: { minReceived: 4.9 },
    }),
  createWithdrawalAddresses: async () => err(upstreamErr),
  getStatus: async () =>
    ok({
      transactions: [
        {
          fromChainId: "8453",
          fromTokenAddress: "0x8335",
          fromAmountBaseUnit: "5000000",
          status: "PROCESSING",
          txHash: null,
          createdTimeMs: 1_784_000_000_000,
        },
      ],
    }),
  ...over,
});

const buildFundsApp = async (opts: {
  bridgeFunding?: boolean;
  bridgeClient?: BridgeClient;
  bridgeStore?: ReturnType<typeof makeBridgeStore>;
  hasDepositWallet?: boolean;
}): Promise<{ app: FastifyInstance; bridgeStore: ReturnType<typeof makeBridgeStore> }> => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    FEATURE_BRIDGE_FUNDING: opts.bridgeFunding === false ? "false" : "true",
  });
  const bridgeStore = opts.bridgeStore ?? makeBridgeStore();
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
  const tradingAccounts = {
    listByOwner: async () =>
      opts.hasDepositWallet === false
        ? []
        : [
            {
              id: "acct-1",
              kind: "internal_privy",
              signerAddress: "0x1212121212121212121212121212121212121212",
              depositWalletAddress: DEPOSIT_WALLET,
            },
          ],
  } as unknown as TradingAccountStore;

  const app = Fastify();
  await app.register(fastifyCookie);
  registerFundsRoutes(app, {
    config,
    sessions,
    auditStore,
    tradingAccounts,
    privyWallets,
    bridgeClient: opts.bridgeClient ?? makeBridgeClient(),
    bridgeStore,
    geoblockClient,
  });
  return { app, bridgeStore };
};

beforeEach(() => {});

describe("POST /api/funds/quote", () => {
  it("fails closed when bridge funding is off", async () => {
    const { app } = await buildFundsApp({ bridgeFunding: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/funds/quote",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: { fromChainId: "8453", fromTokenAddress: "0x8335", fromAmountBaseUnit: "5000000" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("server-fills the pUSD leg — the browser never supplies the destination", async () => {
    let quoted: Record<string, string> | null = null;
    const bridgeClient = makeBridgeClient({
      getQuote: async (params) => {
        quoted = params as unknown as Record<string, string>;
        return ok({ quoteId: "q-1", estOutputUsd: 4.95 });
      },
    });
    const { app } = await buildFundsApp({ bridgeClient });
    const res = await app.inject({
      method: "POST",
      url: "/api/funds/quote",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: { fromChainId: "8453", fromTokenAddress: "0x8335", fromAmountBaseUnit: "5000000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quoteId).toBe("q-1");
    expect(quoted!["toChainId"]).toBe("137");
    expect(quoted!["toTokenAddress"]).toBe(PUSD_ADDRESS);
    expect(quoted!["recipientAddress"]).toBe(DEPOSIT_WALLET);
    await app.close();
  });

  it("rejects a smuggled destination field (strict schema)", async () => {
    const { app } = await buildFundsApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/funds/quote",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: {
        fromChainId: "8453",
        fromTokenAddress: "0x8335",
        fromAmountBaseUnit: "5000000",
        recipientAddress: "0xattacker",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("deposit addresses + tracked deposits", () => {
  it("persists generated addresses so the poller and sheet can reuse them", async () => {
    const { app, bridgeStore } = await buildFundsApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(bridgeStore.addresses).toHaveLength(1);
    expect(bridgeStore.addresses[0]!.address).toBe("0x3333333333333333333333333333333333333333");
    expect(bridgeStore.addresses[0]!.kind).toBe("deposit");
    await app.close();
  });

  it("refresh=1 pulls status, upserts deposits idempotently, and never regresses state", async () => {
    const bridgeStore = makeBridgeStore();
    let status = "PROCESSING";
    const bridgeClient = makeBridgeClient({
      getStatus: async () =>
        ok({
          transactions: [
            {
              fromChainId: "8453",
              fromTokenAddress: "0x8335",
              fromAmountBaseUnit: "5000000",
              status,
              txHash: status === "COMPLETED" ? "0xabc" : null,
              createdTimeMs: 1_784_000_000_000,
            },
          ],
        }),
    });
    const { app } = await buildFundsApp({ bridgeClient, bridgeStore });

    await app.inject({
      method: "POST",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });

    const first = await app.inject({
      method: "GET",
      url: "/api/funds/deposits?refresh=1",
      headers: { cookie: COOKIE },
    });
    expect(first.json().deposits).toHaveLength(1);
    expect(first.json().deposits[0].state).toBe("processing");

    // Same transaction again → no duplicate row.
    const second = await app.inject({
      method: "GET",
      url: "/api/funds/deposits?refresh=1",
      headers: { cookie: COOKIE },
    });
    expect(second.json().deposits).toHaveLength(1);

    // Provider progressed → state moves forward.
    status = "COMPLETED";
    const third = await app.inject({
      method: "GET",
      url: "/api/funds/deposits?refresh=1",
      headers: { cookie: COOKIE },
    });
    expect(third.json().deposits[0].state).toBe("completed");
    await app.close();
  });

  it("refresh=1 hits the Bridge at most once per address per interval", async () => {
    const bridgeStore = makeBridgeStore();
    // This store variant actually stamps lastCheckedAt (the shared fake
    // no-ops it so older tests can refresh back-to-back).
    bridgeStore.markAddressChecked = async (id: string) => {
      const row = bridgeStore.addresses.find((a) => a.id === id);
      if (row) row.lastCheckedAt = new Date();
    };
    let statusCalls = 0;
    const bridgeClient = makeBridgeClient({
      getStatus: async () => {
        statusCalls += 1;
        return ok({ transactions: [] });
      },
    });
    const { app } = await buildFundsApp({ bridgeClient, bridgeStore });
    await app.inject({
      method: "POST",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });

    await app.inject({
      method: "GET",
      url: "/api/funds/deposits?refresh=1",
      headers: { cookie: COOKIE },
    });
    await app.inject({
      method: "GET",
      url: "/api/funds/deposits?refresh=1",
      headers: { cookie: COOKIE },
    });
    expect(statusCalls).toBe(1); // second call inside the interval skipped

    // Address becomes stale again → next refresh hits the Bridge.
    bridgeStore.addresses[0]!.lastCheckedAt = new Date(Date.now() - 10_000);
    await app.inject({
      method: "GET",
      url: "/api/funds/deposits?refresh=1",
      headers: { cookie: COOKIE },
    });
    expect(statusCalls).toBe(2);
    await app.close();
  });

  it("GET returns saved addresses without touching the Bridge, empty before first POST", async () => {
    let bridgeCalls = 0;
    const bridgeClient = makeBridgeClient({
      createDepositAddresses: async () => {
        bridgeCalls += 1;
        return ok({ evm: "0x3333333333333333333333333333333333333333", svm: "So1anaAddr" });
      },
    });
    const { app } = await buildFundsApp({ bridgeClient });

    const before = await app.inject({
      method: "GET",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().addresses).toEqual({});
    expect(bridgeCalls).toBe(0);

    await app.inject({
      method: "POST",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(bridgeCalls).toBe(1);

    const after = await app.inject({
      method: "GET",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(after.json().addresses).toEqual({
      evm: "0x3333333333333333333333333333333333333333",
      svm: "So1anaAddr",
    });
    expect(after.json().depositWalletAddress).toBe(DEPOSIT_WALLET);
    expect(bridgeCalls).toBe(1);
    await app.close();
  });

  it("GET never surfaces addresses tied to a stale deposit wallet", async () => {
    const bridgeStore = makeBridgeStore();
    await bridgeStore.saveAddress({
      walletAddress: WALLET,
      depositWalletAddress: "0x0000000000000000000000000000000000000bad",
      kind: "deposit",
      addressType: "evm",
      address: "0x4444444444444444444444444444444444444444",
    });
    const { app } = await buildFundsApp({ bridgeStore });
    const res = await app.inject({
      method: "GET",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().addresses).toEqual({});
    await app.close();
  });

  it("GET is a soft empty result when no deposit wallet exists yet", async () => {
    const { app } = await buildFundsApp({ hasDepositWallet: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, depositWalletAddress: null, addresses: {} });
    await app.close();
  });

  it("requires an activated deposit wallet", async () => {
    const { app } = await buildFundsApp({ hasDepositWallet: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("DEPOSIT_WALLET_REQUIRED");
    await app.close();
  });

  it("fails closed when geoblock errors", async () => {
    const blockedGeo: GeoblockClient = { check: async () => err(upstreamErr) };
    const config = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      FEATURE_BRIDGE_FUNDING: "true",
    });
    const app = Fastify();
    await app.register(fastifyCookie);
    registerFundsRoutes(app, {
      config,
      sessions,
      auditStore,
      tradingAccounts: { listByOwner: async () => [] } as unknown as TradingAccountStore,
      privyWallets: { find: async () => null } as unknown as PrivyWalletStore,
      bridgeClient: makeBridgeClient(),
      bridgeStore: makeBridgeStore(),
      geoblockClient: blockedGeo,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/funds/deposit-addresses",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("GEO_BLOCKED");
    await app.close();
  });
});

// Placed last so the first test here sees a cold module-level price cache; the
// prices route touches no auth/store, only the stubbed global fetch.
describe("GET /api/funds/prices", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("maps CoinGecko ids to symbol prices (POL prefers the new id)", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        ethereum: { usd: 3500.5 },
        "polygon-ecosystem-token": { usd: 0.42 },
        "matic-network": { usd: 0.99 },
        binancecoin: { usd: 600 },
        bitcoin: { usd: 95_000 },
        "wrapped-bitcoin": { usd: 94_900 },
        solana: { usd: 150 },
      }),
    })) as unknown as typeof fetch;
    const { app } = await buildFundsApp({});
    const res = await app.inject({ method: "GET", url: "/api/funds/prices" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prices.ETH).toBe(3500.5);
    expect(body.prices.POL).toBe(0.42); // new id wins over legacy matic-network
    expect(body.prices.BNB).toBe(600);
    expect(body.prices.WBTC).toBe(94_900);
    expect(body.prices.BTC).toBe(95_000);
    await app.close();
  });

  it("serves cache within TTL and never surfaces upstream errors (HTTP 200)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { app } = await buildFundsApp({});
    const res = await app.inject({ method: "GET", url: "/api/funds/prices" });
    expect(res.statusCode).toBe(200);
    expect(res.json().prices.ETH).toBe(3500.5); // last-known cache, fetch skipped
    expect(calls).toBe(0);
    await app.close();
  });
});
