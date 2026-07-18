import { describe, it, expect } from "vitest";
import { ok, err, encryptCredentials } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import { createMockTradingSigner } from "@mx2/trading-signer";
import type {
  AuditStore,
  ClobCredentialStore,
  DelegationStore,
  OrderIntentStore,
  PrivyWalletStore,
  RuleStore,
  RuntimeFlagStore,
  TriggerStore,
  PrivyWalletRow,
  OrderIntentRow,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
} from "@mx2/db";
import type { AuthenticatedClobClient } from "@mx2/polymarket-client";
import { normalizeDefinition, type RuleDefinition, type TriggerEvidence } from "@mx2/rules";
import { createAutoExecutor, type AutoExecRule } from "./auto-executor.js";

const KEY = "a".repeat(64);
const WALLET = "0xowner";
const EMBEDDED = "0x1111111111111111111111111111111111111111";

const config = loadConfig({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_ENCRYPTION_MASTER_KEY: KEY,
  FEATURE_LIVE_TRADING: "true",
  FEATURE_PRIVY_SIGNING: "true",
  FEATURE_CONDITIONAL_LIVE_EXECUTION: "true",
  MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  ORDER_RATE_LIMIT_PER_MIN: "5",
});

const logger = createLogger({ name: "auto-exec-test", level: "silent" });

const def: RuleDefinition = {
  version: 1,
  tokenId: "123456789",
  conditionId: "cond-1",
  outcomeSide: "BUY",
  predicates: [{ kind: "price", source: "ask", comparator: "lte", threshold: 0.5 }],
  continuousWindowMs: 1000,
  maxDataAgeMs: 2000,
  action: { kind: "prepare_order", side: "BUY", price: 0.5, size: 10, orderType: "GTC" },
  recurrence: "once",
  expiresAtMs: null,
  executionMode: "auto",
  negRisk: false,
};

// Auto strategies must carry limits (W5); the base fixture is fully armed so
// tests traverse the whole guard chain unless they override something.
const LIMITS = { maxNotionalPerOrder: 10, maxDailyNotional: 20, maxTotalNotional: 50 };
const rule: AutoExecRule = {
  id: "rule-1",
  walletAddress: WALLET,
  tokenId: "123456789",
  def: { ...normalizeDefinition(def), limits: LIMITS },
};
const evidence = { triggeredAtMs: 1000 } as unknown as TriggerEvidence;

const walletRow: PrivyWalletRow = {
  walletAddress: WALLET,
  privyUserId: WALLET,
  privyWalletId: "pw-1",
  embeddedAddress: EMBEDDED,
  policyId: "policy-1",
  allowancesBootstrappedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const intentRow: OrderIntentRow = {
  id: "intent-1",
  walletAddress: WALLET,
  tradingAccountId: null,
  idempotencyKey: "auto:rule-1:trig-1",
  conditionId: "cond-1",
  tokenId: "123456789",
  side: "BUY",
  price: "0.5",
  size: "10",
  orderType: "GTC",
  funder: EMBEDDED,
  signer: EMBEDDED,
  signatureType: 0,
  signingMode: "server",
  status: "pending",
  clobOrderId: null,
  errorMessage: null,
  filledSize: "0",
  avgFillPrice: null,
  lastSyncedAt: null,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface Harness {
  deps: Parameters<typeof createAutoExecutor>[0];
  audits: string[];
  ruleStatus: () => string;
  submitted: () => boolean;
}

const makeHarness = (
  over: {
    paused?: boolean;
    autoDisabled?: boolean;
    delegationActive?: boolean;
    delegationExpiresInMs?: number;
    allowances?: boolean;
    recentCount?: number;
    dailyExecuted?: number;
    lifetimeExecuted?: number;
    balanceUsd?: number | null;
    casLoses?: boolean;
    existingIntent?: boolean;
    submitOk?: boolean;
    noDepositAccount?: boolean;
    noAccountCreds?: boolean;
  } = {},
): Harness => {
  const audits: string[] = [];
  const auditMeta: Record<string, unknown>[] = [];
  let ruleStatus = "TRIGGERED_AWAITING_USER";
  let submitted = false;
  void auditMeta;

  const auditStore: AuditStore = {
    emit: async (e) => {
      audits.push(e.action);
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

  const ruleStore = {
    findById: async () =>
      ({ id: "rule-1", totalNotionalExecuted: String(over.lifetimeExecuted ?? 0) }) as never,
    addExecutedNotional: async () => {},
    markExecuting: async () => {
      if (over.casLoses) return null; // CAS lost → executor aborts
      ruleStatus = "EXECUTING";
      return { id: "rule-1" } as never; // truthy row = claim won
    },
    markAutoExecuted: async () => {
      ruleStatus = "EXECUTED_AUTO";
      return { id: "rule-1" } as never;
    },
    markExecutionFailed: async (_id: string, msg: string) => {
      ruleStatus = `EXECUTION_FAILED:${msg}`;
      return { id: "rule-1" } as never;
    },
  } as unknown as RuleStore;

  const privyWallets = {
    find: async () => ({
      ...walletRow,
      allowancesBootstrappedAt: over.allowances === false ? null : new Date(),
    }),
  } as unknown as PrivyWalletStore;

  const delegations = {
    findActive: async () =>
      over.delegationActive === false
        ? null
        : ({
            id: "d",
            // Anchored to the executor's test clock (run() passes nowMs=1000).
            expiresAt: new Date(1000 + (over.delegationExpiresInMs ?? 7 * 86_400_000)),
          } as never),
  } as unknown as DelegationStore;

  const runtimeFlags = {
    get: async (key: string) => {
      if (key === "trading_paused" && over.paused)
        return { key, value: "true", updatedBy: "a", updatedAt: new Date() };
      if (key === `rule_auto_disabled:${rule.id}` && over.autoDisabled)
        return { key, value: "true", updatedBy: WALLET, updatedAt: new Date() };
      return null;
    },
  } as unknown as RuntimeFlagStore;

  const orderIntents = {
    countRecentByWallet: async () => over.recentCount ?? 0,
    sumRuleAutoNotional: async () => over.dailyExecuted ?? 0,
    findByIdempotencyKey: async () => (over.existingIntent ? intentRow : null),
    create: async () => intentRow,
    updateStatus: async () => {},
  } as unknown as OrderIntentStore;

  const clobCredentials = {
    find: async () => ({
      walletAddress: WALLET,
      encryptedCreds: encryptCredentials(
        { apiKey: "ak", secret: Buffer.from("s").toString("base64"), passphrase: "p" },
        KEY,
      ),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as unknown as ClobCredentialStore;

  const tradingClobClient = {
    submitOrder: async () => {
      submitted = true;
      return over.submitOk === false
        ? err({ code: "UPSTREAM_ERROR", message: "rejected", statusCode: 400 })
        : ok({ orderID: "clob-1", status: "live" });
    },
  } as unknown as AuthenticatedClobClient;

  const triggerStore = { updateStatus: async () => {} } as unknown as TriggerStore;

  // W4: the deposit-wallet account + per-account CLOB creds the live order
  // path requires. Present by default so the base harness is fully armed.
  const tradingAccounts = {
    listByOwner: async () =>
      over.noDepositAccount
        ? []
        : [
            {
              id: "acct-1",
              kind: "internal_privy",
              archivedAt: null,
              privyWalletId: "pw-1",
              depositWalletAddress: "0x9999999999999999999999999999999999999999",
              signerAddress: EMBEDDED,
            } as never,
          ],
  } as unknown as TradingAccountStore;

  const accountClobCredentials = {
    find: async () =>
      over.noAccountCreds
        ? null
        : ({
            tradingAccountId: "acct-1",
            ownerWalletAddress: WALLET,
            encryptedCreds: encryptCredentials(
              { apiKey: "ak", secret: Buffer.from("s").toString("base64"), passphrase: "p" },
              KEY,
            ),
            createdAt: new Date(),
            updatedAt: new Date(),
          } as never),
  } as unknown as TradingAccountClobCredentialStore;

  return {
    deps: {
      logger,
      config,
      tradingSigner: createMockTradingSigner({ privateKey: `0x${"1".repeat(64)}` }),
      privyWallets,
      delegations,
      runtimeFlags,
      orderIntents,
      clobCredentials,
      tradingAccounts,
      accountClobCredentials,
      tradingClobClient,
      ruleStore,
      triggerStore,
      auditStore,
      balanceOfUsdc: over.balanceUsd === null ? null : async () => over.balanceUsd ?? 1_000,
    },
    audits,
    ruleStatus: () => ruleStatus,
    submitted: () => submitted,
  };
};

const run = async (h: Harness) => {
  const exec = createAutoExecutor(h.deps);
  await exec.execute({ rule, triggerId: "trig-1", evidence, nowMs: 1000 });
};

describe("auto-executor", () => {
  it("submits a POLY_1271 order through the full guard chain (W4 happy path)", async () => {
    const h = makeHarness();
    await run(h);
    expect(h.submitted()).toBe(true);
    expect(h.ruleStatus()).toBe("EXECUTED_AUTO");
    expect(h.audits).toContain("order.intent");
    expect(h.audits).toContain("order.submitted");
    expect(h.audits).toContain("rule.executed_auto");
    expect(h.audits).not.toContain("rule.execution.skipped");
  });

  it("skips (deposit_wallet_required) when no internal deposit-wallet account exists", async () => {
    const h = makeHarness({ noDepositAccount: true });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips (clob_credentials_missing) when the account has no CLOB creds", async () => {
    const h = makeHarness({ noAccountCreds: true });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips (no submit) when the kill switch is active", async () => {
    const h = makeHarness({ paused: true });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
    expect(h.ruleStatus()).toBe("TRIGGERED_AWAITING_USER"); // degrades to manual
  });

  it("skips when the delegation has expired", async () => {
    const h = makeHarness({ delegationActive: false });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips when allowances are not bootstrapped", async () => {
    const h = makeHarness({ allowances: false });
    await run(h);
    expect(h.submitted()).toBe(false);
  });

  it("skips and audits when the rate limit is exceeded", async () => {
    const h = makeHarness({ recentCount: 5 });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("order.rate_limited");
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("aborts when the compare-and-set claim is lost (user acted concurrently)", async () => {
    const h = makeHarness({ casLoses: true });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("does not double-submit when an intent already exists (idempotent)", async () => {
    const h = makeHarness({ existingIntent: true });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.ruleStatus()).toBe("TRIGGERED_AWAITING_USER");
  });

  it("marks EXECUTION_FAILED (never degrades to re-submission) when the CLOB rejects", async () => {
    const h = makeHarness({ submitOk: false });
    await run(h);
    expect(h.submitted()).toBe(true);
    expect(h.ruleStatus()).toBe("EXECUTION_FAILED:rejected");
    expect(h.audits).toContain("rule.execution.failed");
    expect(h.audits).not.toContain("rule.executed_auto");
  });

  // ── W5–W8 guard chain ──────────────────────────────────────────────────────

  it("skips when the strategy has no spending limits (auto requires limits)", async () => {
    const h = makeHarness();
    const exec = createAutoExecutor(h.deps);
    await exec.execute({
      rule: { ...rule, def: { ...rule.def, limits: null } },
      triggerId: "trig-1",
      evidence,
      nowMs: 1000,
    });
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips when the order exceeds the per-order cap", async () => {
    const h = makeHarness();
    const exec = createAutoExecutor(h.deps);
    await exec.execute({
      rule: {
        ...rule,
        def: {
          ...rule.def,
          limits: { maxNotionalPerOrder: 1, maxDailyNotional: 20, maxTotalNotional: 50 },
        },
      },
      triggerId: "trig-1",
      evidence,
      nowMs: 1000,
    });
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips when today's executed notional would exceed the daily cap", async () => {
    // Order = 0.5 × 10 = $5; daily cap $20 with $16 already executed today.
    const h = makeHarness({ dailyExecuted: 16 });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips when the lifetime total cap is exhausted (survives restarts)", async () => {
    const h = makeHarness({ lifetimeExecuted: 48 });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips when the strategy has been disarmed (per-rule kill)", async () => {
    const h = makeHarness({ autoDisabled: true });
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("skips when the funding wallet balance cannot cover the order", async () => {
    const h = makeHarness({ balanceUsd: 2 }); // order costs $5
    await run(h);
    expect(h.submitted()).toBe(false);
    expect(h.audits).toContain("rule.execution.skipped");
  });

  it("emits a delegation.expiring warning inside the 48h window", async () => {
    const h = makeHarness({ delegationExpiresInMs: 24 * 3_600_000 });
    await run(h);
    expect(h.audits).toContain("delegation.expiring");
  });

  it("does not warn about delegation expiry when plenty of time remains", async () => {
    const h = makeHarness({ delegationExpiresInMs: 7 * 86_400_000 });
    await run(h);
    expect(h.audits).not.toContain("delegation.expiring");
  });
});
