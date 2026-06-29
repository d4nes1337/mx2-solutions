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
} from "@mx2/db";
import type { AuthenticatedClobClient } from "@mx2/polymarket-client";
import type { RuleDefinition, TriggerEvidence } from "@mx2/rules";
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

const rule: AutoExecRule = { id: "rule-1", walletAddress: WALLET, tokenId: "123456789", def };
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
  idempotencyKey: "auto:rule-1:trig-1",
  conditionId: "cond-1",
  tokenId: "123456789",
  side: "BUY",
  price: "0.5",
  size: "10",
  orderType: "GTC",
  funder: EMBEDDED,
  status: "pending",
  clobOrderId: null,
  errorMessage: null,
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
    delegationActive?: boolean;
    allowances?: boolean;
    recentCount?: number;
    casLoses?: boolean;
    existingIntent?: boolean;
    submitOk?: boolean;
  } = {},
): Harness => {
  const audits: string[] = [];
  let ruleStatus = "TRIGGERED_AWAITING_USER";
  let submitted = false;

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
  };

  const ruleStore = {
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
    findActive: async () => (over.delegationActive === false ? null : ({ id: "d" } as never)),
  } as unknown as DelegationStore;

  const runtimeFlags = {
    get: async () =>
      over.paused
        ? { key: "trading_paused", value: "true", updatedBy: "a", updatedAt: new Date() }
        : null,
  } as unknown as RuntimeFlagStore;

  const orderIntents = {
    countRecentByWallet: async () => over.recentCount ?? 0,
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
      tradingClobClient,
      ruleStore,
      triggerStore,
      auditStore,
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
  it("builds, signs, and submits on the happy path → EXECUTED_AUTO", async () => {
    const h = makeHarness();
    await run(h);
    expect(h.submitted()).toBe(true);
    expect(h.ruleStatus()).toBe("EXECUTED_AUTO");
    expect(h.audits).toContain("order.submitted");
    expect(h.audits).toContain("rule.executed_auto");
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
    expect(h.ruleStatus()).toBe("EXECUTED_AUTO");
  });

  it("marks EXECUTION_FAILED when submission fails", async () => {
    const h = makeHarness({ submitOk: false });
    await run(h);
    expect(h.submitted()).toBe(true);
    expect(h.ruleStatus()).toContain("EXECUTION_FAILED");
    expect(h.audits).toContain("order.failed");
    expect(h.audits).toContain("rule.execution.failed");
  });
});
