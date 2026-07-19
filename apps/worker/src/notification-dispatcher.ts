import { createHash, randomBytes } from "node:crypto";
import type { Logger } from "@mx2/observability";
import {
  isKindEnabled,
  type AuditStore,
  type NotificationChannelStore,
  type NotificationKind,
  type NotificationOutboxStore,
  type SignLinkTokenStore,
} from "@mx2/db";
import type { TelegramApi } from "./telegram/api.js";
import { formatNotification, toPlainText, type NotificationPayload } from "./telegram/format.js";
import type { DiscordApi } from "./discord/api.js";

/**
 * Outbox → Telegram delivery loop. Single consumer (D-001 single process):
 * claims due pending rows, resolves the wallet's active channels, honors
 * per-kind preferences, and sends. Failures retry with exponential backoff
 * (store-level) and fail terminally after MAX_SEND_ATTEMPTS — a Telegram
 * outage can never wedge the worker.
 *
 * Sign links are minted HERE, at send time, so the 30-minute token TTL starts
 * when the user is told about the order — not when the trigger fired.
 */

export const SIGN_LINK_TTL_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 10;

/** Mint a single-use sign-link token and return the mobile sign URL. */
export const mintSignLink = async (opts: {
  signTokens: SignLinkTokenStore;
  appBaseUrl: string;
  walletAddress: string;
  triggerId: string;
}): Promise<string> => {
  const token = randomBytes(24).toString("base64url");
  await opts.signTokens.create({
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
    walletAddress: opts.walletAddress,
    triggerId: opts.triggerId,
    expiresAt: new Date(Date.now() + SIGN_LINK_TTL_MS),
  });
  return `${opts.appBaseUrl.replace(/\/$/, "")}/m/t/${opts.triggerId}?t=${token}`;
};

export interface NotificationDispatcherDeps {
  logger: Logger;
  /** Telegram delivery (FEATURE_TELEGRAM_BOT); absent → telegram channels skip. */
  api?: TelegramApi;
  /** Discord DM delivery (FEATURE_DISCORD_BOT); absent → discord channels skip. */
  discordApi?: DiscordApi;
  outbox: NotificationOutboxStore;
  channels: NotificationChannelStore;
  signTokens: SignLinkTokenStore;
  auditStore: AuditStore;
  /** Public web origin for links in messages (config.baseUrl). */
  appBaseUrl: string;
  /**
   * FEATURE_TELEGRAM_MINIAPP: sign notifications get a web_app button (opens
   * inside Telegram, auth via initData). Requires an https appBaseUrl —
   * Telegram rejects web_app buttons pointing at plain-http URLs, so this is
   * additionally gated on the scheme below.
   */
  miniapp?: boolean;
  intervalMs?: number;
  batchSize?: number;
}

export interface NotificationDispatcher {
  start(): void;
  stop(): void;
  /** One delivery pass — exposed for tests. */
  tick(): Promise<void>;
}

export const createNotificationDispatcher = (
  deps: NotificationDispatcherDeps,
): NotificationDispatcher => {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const miniappBase =
    deps.miniapp === true && deps.appBaseUrl.startsWith("https://")
      ? deps.appBaseUrl.replace(/\/$/, "")
      : null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const due = await deps.outbox.claimDue(batchSize);
      for (const row of due) {
        const kind = row.kind as NotificationKind;
        try {
          const channels = (await deps.channels.listActiveByWallet(row.walletAddress)).filter(
            (c) =>
              ((c.channel === "telegram" && deps.api) ||
                (c.channel === "discord" && deps.discordApi)) &&
              isKindEnabled(c.preferences, kind),
          );
          if (channels.length === 0) {
            await deps.outbox.markSkipped(row.id, "no active telegram channel opted in");
            continue;
          }

          const payload = row.payload as NotificationPayload;
          const signUrl =
            kind === "order_awaiting_signature" && payload.triggerId
              ? await mintSignLink({
                  signTokens: deps.signTokens,
                  appBaseUrl: deps.appBaseUrl,
                  walletAddress: row.walletAddress,
                  triggerId: payload.triggerId,
                })
              : undefined;
          const msg = formatNotification(kind, payload, {
            appBaseUrl: deps.appBaseUrl,
            ...(signUrl !== undefined ? { signUrl } : {}),
            ...(kind === "order_awaiting_signature" && payload.triggerId && miniappBase
              ? { miniappSignUrl: `${miniappBase}/m/t/${payload.triggerId}` }
              : {}),
          });

          let failure: string | null = null;
          for (const channel of channels) {
            if (channel.channel === "telegram" && deps.api) {
              const res = await deps.api.sendMessage({
                chatId: channel.externalId,
                html: msg.html,
                buttons: msg.buttons,
              });
              if (!res.ok) failure = res.description ?? "sendMessage failed";
            } else if (channel.channel === "discord" && deps.discordApi) {
              // Discord DMs: plain text + link buttons only (web_app/callback
              // buttons are Telegram concepts — the tokenized sign URL carries
              // the whole flow).
              const linkButtons = msg.buttons
                .flat()
                .filter((b): b is { text: string; url: string } => typeof b.url === "string")
                .map((b) => ({ label: b.text, url: b.url }));
              const res = await deps.discordApi.sendDirectMessage({
                userId: channel.externalId,
                content: toPlainText(msg.html),
                linkButtons,
              });
              if (!res.ok) failure = res.description ?? "discord send failed";
            }
          }

          if (failure !== null) {
            await deps.outbox.markAttemptFailed(row.id, failure);
            await deps.auditStore.emit({
              actor: "system",
              action: "notification.send_failed",
              subject: `notification:${row.id}`,
              metadata: { kind, wallet: row.walletAddress, error: failure },
            });
          } else {
            await deps.outbox.markSent(row.id);
            await deps.auditStore.emit({
              actor: "system",
              action: "notification.sent",
              subject: `notification:${row.id}`,
              metadata: { kind, wallet: row.walletAddress, channels: channels.length },
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "dispatch failed";
          deps.logger.error({ err: error, outboxId: row.id }, "notification dispatch failed");
          await deps.outbox.markAttemptFailed(row.id, message);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      deps.logger.info({ intervalMs }, "notification dispatcher started");
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
};
