/**
 * Minimal typed Telegram Bot API client (no SDK dependency). Only the four
 * methods the bot + dispatcher need. The bot token is embedded in request
 * URLs per the Bot API contract — it must NEVER appear in logs or thrown
 * errors, so every failure path strips it to a plain description.
 */

export interface TelegramInlineButton {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: { url: string };
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramIncomingMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramIncomingMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface SendResult {
  ok: boolean;
  /** Failure description, token-free. */
  description?: string;
  /** Set on 429 — the flood-control pause Telegram asked for. */
  retryAfterSec?: number;
}

export interface TelegramApi {
  sendMessage(opts: {
    chatId: string;
    /** HTML parse mode — caller is responsible for escaping (see format.ts). */
    html: string;
    buttons?: TelegramInlineButton[][];
  }): Promise<SendResult>;
  /** Long poll; resolves [] on transport errors (caller just polls again). */
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  editMessageReplyMarkup(opts: {
    chatId: string;
    messageId: number;
    buttons: TelegramInlineButton[][];
  }): Promise<void>;
}

interface BotApiEnvelope {
  ok: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
}

export const createTelegramApi = (opts: {
  botToken: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): TelegramApi => {
  const baseUrl = opts.baseUrl ?? "https://api.telegram.org";
  const fetchFn = opts.fetchFn ?? fetch;

  const call = async (
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<BotApiEnvelope> => {
    try {
      const res = await fetchFn(`${baseUrl}/bot${opts.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return (await res.json()) as BotApiEnvelope;
    } catch (error) {
      // Token-free failure: never surface the request URL.
      return {
        ok: false,
        description: error instanceof Error ? error.message : "telegram request failed",
      };
    }
  };

  return {
    async sendMessage({ chatId, html, buttons }) {
      const envelope = await call("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
      if (envelope.ok) return { ok: true };
      return {
        ok: false,
        description: envelope.description ?? "sendMessage failed",
        ...(envelope.parameters?.retry_after !== undefined
          ? { retryAfterSec: envelope.parameters.retry_after }
          : {}),
      };
    },

    async getUpdates(offset, timeoutSec) {
      const envelope = await call(
        "getUpdates",
        { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
        (timeoutSec + 10) * 1000,
      );
      if (!envelope.ok || !Array.isArray(envelope.result)) return [];
      return envelope.result as TelegramUpdate[];
    },

    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    },

    async editMessageReplyMarkup({ chatId, messageId, buttons }) {
      await call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
      });
    },
  };
};
