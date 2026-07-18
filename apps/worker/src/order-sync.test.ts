import { describe, it, expect } from "vitest";
import { ok, err, encryptCredentials } from "@mx2/core";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  OrderIntentRow,
  OrderIntentStore,
  TradingAccountClobCredentialStore,
  TradingAccountStore,
} from "@mx2/db";
import type { AuthenticatedClobClient, OpenOrder, UserTrade } from "@mx2/polymarket-client";
import { networkError } from "@mx2/polymarket-client";
import { createOrderSyncLoop } from "./order-sync.js";

const KEY = "a".repeat(64);
const WALLET = "0xowner";
const SIGNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT_ID = "acct-1";
const TOKEN = "tok-1";
const logger = createLogger({ name: "order-sync-test", level: "silent" });

const OLD = new Date(Date.now() - 600_000); // far past the disappear grace

const makeIntent = (over: Partial<OrderIntentRow> = {}): OrderIntentRow => ({
  id: "intent-1",
  walletAddress: WALLET,
  tradingAccountId: ACCOUNT_ID,
  idempotencyKey: "key-1",
  conditionId: "cond-1",
  tokenId: TOKEN,
  side: "BUY",
  price: "0.41",
  size: "10",
  orderType: "GTC",
  funder: null,
  signer: null,
  signatureType: null,
  signingMode: null,
  status: "submitted",
  clobOrderId: "clob-1",
  errorMessage: null,
  filledSize: "0",
  avgFillPrice: null,
  lastSyncedAt: null,
  metadata: { ruleId: "rule-9" },
  createdAt: OLD,
  updatedAt: OLD,
  ...over,
});

const openOrder = (over: Partial<OpenOrder> = {}): OpenOrder => ({
  id: "clob-1",
  market: "cond-1",
  asset_id: TOKEN,
  side: "BUY",
  original_size: "10",
  size_matched: "0",
  price: "0.41",
  status: "LIVE",
  type: "LIMIT",
  ...over,
});

const makerFill = (matched: string, price: string): UserTrade => ({
  id: "trade-1",
  market: "cond-1",
  asset_id: TOKEN,
  side: "SELL",
  size: matched,
  price,
  status: "CONFIRMED",
  match_time: "1700000000",
  maker_orders: [{ order_id: "clob-1", matched_amount: matched, price }],
});

interface Harness {
  loop: ReturnType<typeof createOrderSyncLoop>;
  intents: OrderIntentRow[];
  audits: { action: string; metadata: Record<string, unknown> }[];
}

const IN_FLIGHT = new Set(["submitted", "acknowledged"]);

const makeHarness = (
  intents: OrderIntentRow[],
  clob: {
    open?: OpenOrder[] | "error";
    trades?: UserTrade[] | "error";
    credsMissing?: boolean;
  } = {},
): Harness => {
  const audits: Harness["audits"] = [];

  const orderIntents = {
    listForSync: async () =>
      intents.filter((i) => IN_FLIGHT.has(i.status) && i.clobOrderId !== null),
    updateFillState: async (
      id: string,
      update: {
        status?: string;
        filledSize?: string;
        avgFillPrice?: string | null;
        lastSyncedAt: Date;
      },
    ) => {
      const row = intents.find((i) => i.id === id);
      if (!row || !IN_FLIGHT.has(row.status)) return; // CAS: never regress terminal
      row.lastSyncedAt = update.lastSyncedAt;
      if (update.status !== undefined) row.status = update.status;
      if (update.filledSize !== undefined) row.filledSize = update.filledSize;
      if (update.avgFillPrice !== undefined) row.avgFillPrice = update.avgFillPrice;
    },
  } as unknown as OrderIntentStore;

  const tradingAccounts = {
    findByOwner: async (_owner: string, id: string) =>
      id === ACCOUNT_ID
        ? { id: ACCOUNT_ID, ownerWalletAddress: WALLET, signerAddress: SIGNER, archivedAt: null }
        : null,
  } as unknown as TradingAccountStore;

  const accountClobCredentials = {
    find: async () =>
      clob.credsMissing
        ? null
        : {
            tradingAccountId: ACCOUNT_ID,
            ownerWalletAddress: WALLET,
            encryptedCreds: encryptCredentials({ apiKey: "k", secret: "s", passphrase: "p" }, KEY),
          },
  } as unknown as TradingAccountClobCredentialStore;

  const tradingClobClient = {
    getOpenOrders: async () =>
      clob.open === "error" ? err(networkError("boom")) : ok(clob.open ?? []),
    getUserTrades: async () =>
      clob.trades === "error" ? err(networkError("boom")) : ok(clob.trades ?? []),
  } as unknown as AuthenticatedClobClient;

  const auditStore = {
    emit: async (e: { action: string; metadata: Record<string, unknown> }) => {
      audits.push(e);
      return e;
    },
  } as unknown as AuditStore;

  const loop = createOrderSyncLoop({
    logger,
    encryptionMasterKey: KEY,
    orderIntents,
    tradingAccounts,
    accountClobCredentials,
    tradingClobClient,
    auditStore,
  });
  return { loop, intents, audits };
};

describe("order-sync loop", () => {
  it("advances submitted → acknowledged when the order rests in open orders", async () => {
    const h = makeHarness([makeIntent()], { open: [openOrder()] });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("acknowledged");
    expect(h.audits.map((a) => a.action)).toEqual(["order.acknowledged"]);
  });

  it("records partial-fill progress with an audit", async () => {
    const h = makeHarness([makeIntent({ status: "acknowledged" })], {
      open: [openOrder({ size_matched: "4" })],
    });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("acknowledged");
    expect(h.intents[0]!.filledSize).toBe("4");
    expect(h.audits.map((a) => a.action)).toEqual(["order.partially_filled"]);
    expect(h.audits[0]!.metadata["ruleId"]).toBe("rule-9");
  });

  it("resolves a disappeared order with full fills → filled + weighted avg price", async () => {
    const h = makeHarness([makeIntent({ status: "acknowledged" })], {
      open: [],
      trades: [makerFill("6", "0.41"), makerFill("4", "0.40")],
    });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("filled");
    expect(h.intents[0]!.filledSize).toBe("10");
    expect(Number(h.intents[0]!.avgFillPrice)).toBeCloseTo((6 * 0.41 + 4 * 0.4) / 10, 6);
    expect(h.audits.map((a) => a.action)).toEqual(["order.filled"]);
  });

  it("resolves a disappeared order with partial fills → cancelled (partiallyFilled)", async () => {
    const h = makeHarness([makeIntent({ status: "acknowledged" })], {
      open: [],
      trades: [makerFill("3", "0.41")],
    });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("cancelled");
    expect(h.intents[0]!.filledSize).toBe("3");
    expect(h.audits.map((a) => a.action)).toEqual(["order.cancelled"]);
    expect(h.audits[0]!.metadata["partiallyFilled"]).toBe(true);
  });

  it("resolves a disappeared order with no fills → cancelled", async () => {
    const h = makeHarness([makeIntent({ status: "acknowledged" })], { open: [], trades: [] });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("cancelled");
    expect(h.audits[0]!.metadata["partiallyFilled"]).toBe(false);
  });

  it("gives fresh submissions a grace period before declaring them cancelled", async () => {
    const h = makeHarness([makeIntent({ createdAt: new Date(), updatedAt: new Date() })], {
      open: [],
      trades: [],
    });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("submitted");
    expect(h.intents[0]!.lastSyncedAt).not.toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it("leaves intents untouched when the trades lookup fails (fail-closed)", async () => {
    const h = makeHarness([makeIntent({ status: "acknowledged" })], {
      open: [],
      trades: "error",
    });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("acknowledged");
    expect(h.intents[0]!.lastSyncedAt).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it("skips the whole account when getOpenOrders fails", async () => {
    const h = makeHarness([makeIntent()], { open: "error" });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("submitted");
    expect(h.intents[0]!.lastSyncedAt).toBeNull();
  });

  it("stamps intents (no status change) when credentials are missing", async () => {
    const h = makeHarness([makeIntent()], { credsMissing: true });
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("submitted");
    expect(h.intents[0]!.lastSyncedAt).not.toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it("stamps legacy intents without a trading account so they don't block the queue", async () => {
    const h = makeHarness([makeIntent({ tradingAccountId: null })], {});
    await h.loop.runOnce();
    expect(h.intents[0]!.status).toBe("submitted");
    expect(h.intents[0]!.lastSyncedAt).not.toBeNull();
  });
});
