import { decryptCredentials } from "@mx2/core";
import type { AppConfig } from "@mx2/config";
import type { Logger } from "@mx2/observability";
import type {
  PrivyWalletStore,
  QuoterStore,
  RuleStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
} from "@mx2/db";
import {
  createClobV2Session,
  type L2Credentials,
  type RewardsEarningLite,
  type SignTypedDataFn,
} from "@mx2/polymarket-client";
import { normalizeDefinition, type RuleDefinition, type StrategyDefinition } from "@mx2/rules";
import type { TradingSigner } from "@mx2/trading-signer";

/**
 * Liquidity-rewards accrual poller (RFC-0003 §5). Every interval it asks the
 * CLOB for today's (UTC) earnings per wallet with an active maker-loop
 * session, upserts the per-day accrual rows (idempotent — re-polling the same
 * day just refreshes the number) and rolls the lifetime sum up onto the
 * session scoreboard. Read-only against the venue; failures are logged and
 * retried next tick, never fatal.
 */

export interface EarningsClient {
  getEarningsForDay(
    day: string,
  ): Promise<{ ok: true; value: RewardsEarningLite[] } | { ok: false; error: { message: string } }>;
}

export interface RewardsPollerDeps {
  logger: Logger;
  config: AppConfig;
  quoterStore: QuoterStore;
  ruleStore: RuleStore;
  privyWallets: PrivyWalletStore;
  tradingAccounts: TradingAccountStore;
  accountClobCredentials: TradingAccountClobCredentialStore;
  tradingSigner: TradingSigner;
  intervalMs?: number;
  /** Injectable for tests; defaults to a ClobV2Session over the wallet creds. */
  makeEarningsClient?: (opts: {
    signerAddress: string;
    depositWalletAddress: string;
    sign: SignTypedDataFn;
    creds: L2Credentials;
  }) => EarningsClient;
}

export interface RewardsPoller {
  start(): void;
  stop(): void;
  /** One sweep, exposed for tests and the interval alike. */
  pollOnce(nowMs: number): Promise<void>;
}

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export const createRewardsPoller = (deps: RewardsPollerDeps): RewardsPoller => {
  const intervalMs = deps.intervalMs ?? 30 * 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;

  const makeClient =
    deps.makeEarningsClient ??
    ((opts) =>
      createClobV2Session({
        signerAddress: opts.signerAddress,
        sign: opts.sign,
        depositWalletAddress: opts.depositWalletAddress,
        creds: {
          key: opts.creds.apiKey,
          secret: opts.creds.secret,
          passphrase: opts.creds.passphrase,
        },
      }));

  const clientForWallet = async (walletAddress: string): Promise<EarningsClient | null> => {
    const masterKey = deps.config.encryptionMasterKey;
    if (!masterKey) return null;
    const pw = await deps.privyWallets.find(walletAddress);
    if (!pw) return null;
    const accounts = await deps.tradingAccounts.listByOwner(walletAddress);
    const account = accounts.find(
      (a) =>
        a.kind === "internal_privy" &&
        a.archivedAt === null &&
        a.privyWalletId !== null &&
        a.depositWalletAddress !== null &&
        a.signerAddress.toLowerCase() === pw.embeddedAddress.toLowerCase(),
    );
    if (!account?.depositWalletAddress || !account.privyWalletId) return null;
    const credsRow = await deps.accountClobCredentials.find(account.id);
    if (!credsRow) return null;
    let creds: L2Credentials;
    try {
      creds = decryptCredentials<L2Credentials>(
        credsRow.encryptedCreds as Parameters<typeof decryptCredentials>[0],
        masterKey,
      );
    } catch {
      return null;
    }
    const walletRef = { walletId: account.privyWalletId, address: account.signerAddress };
    return makeClient({
      signerAddress: account.signerAddress,
      depositWalletAddress: account.depositWalletAddress,
      sign: async (payload) => {
        const r = await deps.tradingSigner.signClobAuth({ wallet: walletRef, typedData: payload });
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        return r.value.signature;
      },
      creds,
    });
  };

  const pollOnce = async (nowMs: number): Promise<void> => {
    const sessions = await deps.quoterStore.listActiveSessions();
    if (sessions.length === 0) return;
    const day = utcDay(nowMs);

    // Session → its market's conditionId (from the owning rule definition).
    const conditionOf = new Map<string, string>();
    for (const session of sessions) {
      const rule = await deps.ruleStore.findById(session.ruleId);
      if (!rule) continue;
      try {
        const def = normalizeDefinition(rule.definition as RuleDefinition | StrategyDefinition);
        if (def.action.kind === "quote_loop") {
          conditionOf.set(session.id, def.action.market.conditionId);
        }
      } catch {
        /* unparseable definition — skip */
      }
    }

    // One earnings call per wallet; earnings arrive keyed by conditionId.
    const wallets = [...new Set(sessions.map((s) => s.walletAddress))];
    for (const wallet of wallets) {
      const client = await clientForWallet(wallet);
      if (!client) continue; // no live credentials — nothing to poll
      const res = await client.getEarningsForDay(day);
      if (!res.ok) {
        deps.logger.warn({ wallet, err: res.error.message }, "Rewards earnings poll failed");
        continue;
      }
      const byCondition = new Map(res.value.map((e) => [e.conditionId, e.earningsUsd]));
      for (const session of sessions) {
        if (session.walletAddress !== wallet) continue;
        const conditionId = conditionOf.get(session.id);
        if (!conditionId) continue;
        const earned = byCondition.get(conditionId);
        if (earned !== undefined) {
          await deps.quoterStore.upsertRewardAccrual({
            walletAddress: wallet,
            conditionId,
            day,
            rewardsUsd: earned,
            raw: { day, conditionId, earningsUsd: earned },
          });
        }
        const total = await deps.quoterStore.sumRewardAccruals(wallet, conditionId);
        await deps.quoterStore.updateSession(session.id, { rewardsAccruedUsd: total });
      }
    }
  };

  return {
    pollOnce,
    start() {
      timer = setInterval(() => {
        pollOnce(Date.now()).catch((e: unknown) =>
          deps.logger.warn({ err: e }, "Rewards poll sweep failed"),
        );
      }, intervalMs);
      deps.logger.info({ intervalMs }, "Rewards accrual poller started");
    },
    stop() {
      clearInterval(timer);
    },
  };
};
