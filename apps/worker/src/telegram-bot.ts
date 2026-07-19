import { createHash } from "node:crypto";
import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  LinkCodeStore,
  NotificationChannelStore,
  RuleTriggerRow,
  SignLinkTokenStore,
  TriggerStore,
} from "@mx2/db";
import type { TelegramApi, TelegramUpdate } from "./telegram/api.js";
import { escapeHtml, formatNotification, type NotificationPayload } from "./telegram/format.js";
import { mintSignLink } from "./notification-dispatcher.js";

/**
 * Telegram bot inbound loop (long polling — no public webhook URL needed,
 * which matches the single-process deployment D-001). Handles:
 *   /start <code>  — completes the wallet ↔ chat link minted by the web app
 *   /unlink        — revokes this chat's link
 *   /orders        — re-sends every order currently awaiting signature (the
 *                    recovery path when a sign link expired)
 *   dismiss:<id>   — callback button on an order notification
 *
 * Outbound delivery lives in notification-dispatcher.ts; this loop only ever
 * replies to user-initiated updates.
 */

export interface TelegramBotDeps {
  logger: Logger;
  api: TelegramApi;
  channels: NotificationChannelStore;
  linkCodes: LinkCodeStore;
  triggerStore: TriggerStore;
  signTokens: SignLinkTokenStore;
  auditStore: AuditStore;
  /** Public web origin for sign links (config.baseUrl). */
  appBaseUrl: string;
  /** FEATURE_TELEGRAM_MINIAPP (https origins only): web_app sign buttons. */
  miniapp?: boolean;
  /** Long-poll timeout. Default 30 s. */
  pollTimeoutSec?: number;
  /** Pause between failed polls. Default 3 s. */
  errorBackoffMs?: number;
}

export interface TelegramBot {
  start(): void;
  stop(): void;
  /** Process one update — exposed for tests. */
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export const createTelegramBot = (deps: TelegramBotDeps): TelegramBot => {
  const pollTimeoutSec = deps.pollTimeoutSec ?? 30;
  const errorBackoffMs = deps.errorBackoffMs ?? 3_000;
  let running = false;
  let offset = 0;

  const reply = async (chatId: string, html: string): Promise<void> => {
    const res = await deps.api.sendMessage({ chatId, html });
    if (!res.ok) deps.logger.warn({ description: res.description }, "telegram reply failed");
  };

  const handleStart = async (chatId: string, username: string | undefined, code: string) => {
    const consumed = await deps.linkCodes.consume(sha256(code));
    if (!consumed || consumed.channel !== "telegram") {
      await reply(
        chatId,
        "That link code is invalid or expired. Mint a fresh one from the Wallet page.",
      );
      return;
    }
    const channel = await deps.channels.link({
      walletAddress: consumed.walletAddress,
      channel: "telegram",
      externalId: chatId,
      externalUsername: username ?? null,
    });
    await deps.auditStore.emit({
      actor: consumed.walletAddress,
      action: "notification.channel_linked",
      subject: `notification_channel:${channel.id}`,
      metadata: { channel: "telegram" },
    });
    const short = `${consumed.walletAddress.slice(0, 6)}…${consumed.walletAddress.slice(-4)}`;
    await reply(
      chatId,
      `✅ Linked to <b>${escapeHtml(short)}</b>.\n` +
        "You'll get trade alerts here — orders that need your signature come with a sign link.\n" +
        "Commands: /orders — pending signatures, /unlink — disconnect.",
    );
  };

  const handleUnlink = async (chatId: string) => {
    const revoked = await deps.channels.revokeByExternalId("telegram", chatId);
    if (!revoked) {
      await reply(chatId, "This chat isn't linked to a wallet.");
      return;
    }
    await deps.auditStore.emit({
      actor: revoked.walletAddress,
      action: "notification.channel_unlinked",
      subject: `notification_channel:${revoked.id}`,
      metadata: { channel: "telegram", via: "bot" },
    });
    await reply(chatId, "Disconnected. Link again anytime from the Wallet page.");
  };

  const sendAwaitingTrigger = async (chatId: string, trigger: RuleTriggerRow): Promise<void> => {
    const evidence = (trigger.evidence ?? {}) as Record<string, unknown>;
    const payload: NotificationPayload = {
      triggerId: trigger.id,
      ruleId: trigger.ruleId,
      bestBid: typeof evidence.bestBid === "number" ? evidence.bestBid : null,
      bestAsk: typeof evidence.bestAsk === "number" ? evidence.bestAsk : null,
    };
    const signUrl = await mintSignLink({
      signTokens: deps.signTokens,
      appBaseUrl: deps.appBaseUrl,
      walletAddress: trigger.walletAddress,
      triggerId: trigger.id,
    });
    const miniappOk = deps.miniapp === true && deps.appBaseUrl.startsWith("https://");
    const msg = formatNotification("order_awaiting_signature", payload, {
      appBaseUrl: deps.appBaseUrl,
      signUrl,
      ...(miniappOk
        ? { miniappSignUrl: `${deps.appBaseUrl.replace(/\/$/, "")}/m/t/${trigger.id}` }
        : {}),
    });
    await deps.api.sendMessage({ chatId, html: msg.html, buttons: msg.buttons });
  };

  const handleOrders = async (chatId: string) => {
    const channel = await deps.channels.findActiveByExternalId("telegram", chatId);
    if (!channel) {
      await reply(chatId, "This chat isn't linked to a wallet. Link it from the Wallet page.");
      return;
    }
    const awaiting = await deps.triggerStore.listAwaiting(channel.walletAddress);
    if (awaiting.length === 0) {
      await reply(chatId, "No orders are waiting for your signature.");
      return;
    }
    for (const trigger of awaiting) {
      await sendAwaitingTrigger(chatId, trigger);
    }
  };

  const handleDismiss = async (
    callbackQueryId: string,
    chatId: string,
    messageId: number | undefined,
    triggerId: string,
  ) => {
    const channel = await deps.channels.findActiveByExternalId("telegram", chatId);
    const trigger = channel
      ? await deps.triggerStore.findByIdForWallet(triggerId, channel.walletAddress)
      : null;
    if (!channel || !trigger || trigger.status !== "awaiting_user") {
      await deps.api.answerCallbackQuery(callbackQueryId, "Not available anymore.");
      return;
    }
    await deps.triggerStore.updateStatus(triggerId, "dismissed");
    await deps.auditStore.emit({
      actor: channel.walletAddress,
      action: "rule.trigger.dismissed",
      subject: `rule:${trigger.ruleId}`,
      metadata: { triggerId, via: "telegram" },
    });
    await deps.api.answerCallbackQuery(callbackQueryId, "Dismissed.");
    if (messageId !== undefined) {
      await deps.api.editMessageReplyMarkup({ chatId, messageId, buttons: [] });
    }
  };

  const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    try {
      const message = update.message;
      if (message?.text !== undefined && message.chat.type === "private") {
        const chatId = String(message.chat.id);
        const text = message.text.trim();
        if (text.startsWith("/start")) {
          const code = text.slice("/start".length).trim();
          if (code.length > 0) await handleStart(chatId, message.from?.username, code);
          else {
            await reply(
              chatId,
              "Hi! Link this chat from the app's Wallet page to get trade notifications.",
            );
          }
        } else if (text.startsWith("/unlink")) {
          await handleUnlink(chatId);
        } else if (text.startsWith("/orders")) {
          await handleOrders(chatId);
        }
        return;
      }
      const cb = update.callback_query;
      if (cb?.data !== undefined && cb.data.startsWith("dismiss:") && cb.message) {
        await handleDismiss(
          cb.id,
          String(cb.message.chat.id),
          cb.message.message_id,
          cb.data.slice("dismiss:".length),
        );
      }
    } catch (error) {
      deps.logger.error({ err: error, updateId: update.update_id }, "telegram update failed");
    }
  };

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const updates = await deps.api.getUpdates(offset, pollTimeoutSec);
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handleUpdate(update);
        }
        if (updates.length === 0 && running) {
          // Transport hiccups resolve as [] — brief pause avoids a hot loop.
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (error) {
        deps.logger.error({ err: error }, "telegram poll failed");
        await new Promise((r) => setTimeout(r, errorBackoffMs));
      }
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      void loop();
      deps.logger.info("telegram bot long-poll started");
    },
    stop() {
      running = false;
    },
    handleUpdate,
  };
};
