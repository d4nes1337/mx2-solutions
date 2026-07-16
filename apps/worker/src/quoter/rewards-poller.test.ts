import { describe, expect, it } from "vitest";
import { encryptCredentials } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import { createMockTradingSigner } from "@mx2/trading-signer";
import type {
  PrivyWalletStore,
  QuoteSessionRow,
  QuoterStore,
  RuleStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
} from "@mx2/db";
import { createRewardsPoller } from "./rewards-poller.js";

const KEY = "a".repeat(64);
const WALLET = "0xowner";
const EMBEDDED = "0x1111111111111111111111111111111111111111";
const COND = "0x" + "ab".repeat(32);

const config = loadConfig({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_ENCRYPTION_MASTER_KEY: KEY,
});

const logger = createLogger({ name: "rewards-test", level: "silent" });

const quoteLoopDefinition = {
  version: 2,
  name: "farm",
  templateId: null,
  expr: { type: "group", id: "root", op: "and", children: [] },
  holdsForMs: 0,
  maxDataAgeMs: 60_000,
  action: {
    kind: "quote_loop",
    market: { conditionId: COND, yesTokenId: "y", noTokenId: "n", tickSize: "0.01" },
    sizeShares: 100,
    targetSpreadCents: 2,
    requoteToleranceCents: 1,
    maxInventoryShares: 200,
    maxCapitalUsd: 500,
    maxDailyLossUsd: 25,
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
};

describe("rewards poller (B6)", () => {
  it("upserts today's accrual and rolls the lifetime sum onto the session", async () => {
    const accruals: Record<string, unknown>[] = [];
    const sessionUpdates: Record<string, unknown>[] = [];
    const session = {
      id: "qs-1",
      ruleId: "rule-1",
      walletAddress: WALLET,
      status: "quoting",
    } as unknown as QuoteSessionRow;

    const poller = createRewardsPoller({
      logger,
      config,
      quoterStore: {
        listActiveSessions: async () => [session],
        upsertRewardAccrual: async (row: Record<string, unknown>) => {
          accruals.push(row);
        },
        sumRewardAccruals: async () => 12.5,
        updateSession: async (_id: string, update: Record<string, unknown>) => {
          sessionUpdates.push(update);
          return session;
        },
      } as unknown as QuoterStore,
      ruleStore: {
        findById: async () => ({ id: "rule-1", definition: quoteLoopDefinition }) as never,
      } as unknown as RuleStore,
      privyWallets: {
        find: async () => ({
          walletAddress: WALLET,
          privyWalletId: "pw-1",
          embeddedAddress: EMBEDDED,
        }),
      } as unknown as PrivyWalletStore,
      tradingAccounts: {
        listByOwner: async () => [
          {
            id: "acct-1",
            kind: "internal_privy",
            archivedAt: null,
            privyWalletId: "pw-1",
            depositWalletAddress: "0x9999999999999999999999999999999999999999",
            signerAddress: EMBEDDED,
          } as never,
        ],
      } as unknown as TradingAccountStore,
      accountClobCredentials: {
        find: async () => ({
          encryptedCreds: encryptCredentials(
            { apiKey: "ak", secret: Buffer.from("s").toString("base64"), passphrase: "p" },
            KEY,
          ),
        }),
      } as unknown as TradingAccountClobCredentialStore,
      tradingSigner: createMockTradingSigner({ privateKey: `0x${"1".repeat(64)}` }),
      makeEarningsClient: () => ({
        getEarningsForDay: async (day: string) => ({
          ok: true,
          value: [{ conditionId: COND, earningsUsd: 3.75, day }] as never,
        }),
      }),
    });

    await poller.pollOnce(Date.UTC(2026, 6, 16, 12));

    expect(accruals).toHaveLength(1);
    expect(accruals[0]).toMatchObject({
      walletAddress: WALLET,
      conditionId: COND,
      day: "2026-07-16",
      rewardsUsd: 3.75,
    });
    expect(sessionUpdates).toEqual([{ rewardsAccruedUsd: 12.5 }]);
  });

  it("skips wallets without live credentials without failing the sweep", async () => {
    const session = {
      id: "qs-1",
      ruleId: "rule-1",
      walletAddress: WALLET,
      status: "quoting",
    } as unknown as QuoteSessionRow;
    const updates: unknown[] = [];
    const poller = createRewardsPoller({
      logger,
      config,
      quoterStore: {
        listActiveSessions: async () => [session],
        upsertRewardAccrual: async () => {},
        sumRewardAccruals: async () => 0,
        updateSession: async (_id: string, u: Record<string, unknown>) => {
          updates.push(u);
          return session;
        },
      } as unknown as QuoterStore,
      ruleStore: {
        findById: async () => ({ id: "rule-1", definition: quoteLoopDefinition }) as never,
      } as unknown as RuleStore,
      privyWallets: { find: async () => null } as unknown as PrivyWalletStore,
      tradingAccounts: { listByOwner: async () => [] } as unknown as TradingAccountStore,
      accountClobCredentials: {
        find: async () => null,
      } as unknown as TradingAccountClobCredentialStore,
      tradingSigner: createMockTradingSigner({ privateKey: `0x${"1".repeat(64)}` }),
    });

    await poller.pollOnce(Date.now());
    expect(updates).toHaveLength(0);
  });
});
