import type { Logger } from "@mx2/observability";
import type { ReferralStore } from "@mx2/db";
import { deriveDepositWallet } from "@mx2/polymarket-client";

/**
 * Daily push of the referral mapping to Dune (owner decision 2026-07-28:
 * publicly verifiable referral-volume stats). Uploads a full-replace CSV
 * table via POST /api/v1/uploads/csv → dune.<team>.arima_referrals; the
 * public dashboard joins it against on-chain Polymarket fills by proxy
 * wallet (see docs/dune/README.md).
 *
 * Publishes ONLY pseudonymous, already-public on-chain addresses plus the
 * shareable code handle — no emails, no waitlist PII, no volume numbers
 * (volume comes from the chain itself on Dune's side). Runs only when
 * DUNE_API_KEY is configured; the key is a secret and is never logged.
 */
export interface DunePushOptions {
  logger: Logger;
  referrals: ReferralStore;
  apiKey: string;
  tableName?: string;
  intervalMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export interface DunePushLoop {
  start(): void;
  runOnce(): Promise<void>;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_TABLE_NAME = "arima_referrals";
const UPLOAD_URL = "https://api.dune.com/api/v1/uploads/csv";

export interface ReferralCsvRow {
  code: string;
  ownerWallet: string | null;
  refereeEoa: string;
  redeemedAt: Date;
}

/** RFC-4180-enough: our values are addresses, [A-Z0-9] codes, and ISO dates. */
export const buildReferralCsv = (rows: readonly ReferralCsvRow[]): string => {
  const header = "code,owner_wallet,referee_eoa,referee_proxy_wallet,redeemed_at";
  const lines = rows.map((r) => {
    const proxy = (() => {
      try {
        return deriveDepositWallet(r.refereeEoa).toLowerCase();
      } catch {
        return "";
      }
    })();
    return [
      r.code,
      r.ownerWallet?.toLowerCase() ?? "",
      r.refereeEoa.toLowerCase(),
      proxy,
      r.redeemedAt.toISOString(),
    ].join(",");
  });
  return [header, ...lines].join("\n");
};

export const createDunePushLoop = (opts: DunePushOptions): DunePushLoop => {
  const {
    logger,
    referrals,
    apiKey,
    tableName = DEFAULT_TABLE_NAME,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetchImpl = fetch,
  } = opts;

  let timer: ReturnType<typeof setInterval> | undefined;

  const runOnce = async (): Promise<void> => {
    const [codes, redemptions] = await Promise.all([referrals.list(), referrals.listRedemptions()]);
    if (redemptions.length === 0) {
      logger.info({ event: "dune_push.skipped" }, "dune push: no redemptions yet");
      return;
    }
    const codeById = new Map(codes.map((c) => [c.id, c]));
    const csv = buildReferralCsv(
      redemptions.map((r) => ({
        code: codeById.get(r.codeId)?.code ?? "UNKNOWN",
        ownerWallet: r.referrerWallet,
        refereeEoa: r.walletAddress,
        redeemedAt: r.redeemedAt,
      })),
    );

    const res = await fetchImpl(UPLOAD_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dune-api-key": apiKey },
      body: JSON.stringify({
        table_name: tableName,
        description: "arima referral mapping: code -> referee wallets (refreshed daily)",
        data: csv,
        is_private: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Dune upload failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    logger.info(
      { event: "dune_push.uploaded", rows: redemptions.length, tableName },
      "dune push: table replaced",
    );
  };

  return {
    start() {
      // First push shortly after boot (so a fresh deploy publishes without
      // waiting a day), then daily.
      setTimeout(() => {
        runOnce().catch((e: unknown) => logger.warn({ err: e }, "Dune push failed"));
      }, 60_000);
      timer = setInterval(() => {
        runOnce().catch((e: unknown) => logger.warn({ err: e }, "Dune push failed"));
      }, intervalMs);
    },
    runOnce,
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};
