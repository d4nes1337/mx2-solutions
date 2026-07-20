import type { NotificationKind } from "@mx2/db";
import type { TelegramInlineButton } from "./api.js";

/**
 * Pure notification → Telegram message formatting. All dynamic strings go
 * through escapeHtml — rule names and market questions are user/upstream
 * content and the messages use HTML parse mode.
 */

export const escapeHtml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Telegram-HTML → plain text (Discord DMs and any future plain channel). */
export const toPlainText = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** 0..1 price → whole-cent display ("47¢"); tolerates junk. */
export const formatCents = (price: unknown): string => {
  const n = typeof price === "number" ? price : Number(price);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}¢`;
};

const formatSize = (size: unknown): string => {
  const n = typeof size === "number" ? size : Number(size);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};

/**
 * Payload shape produced by the enqueue hooks. Everything is optional — the
 * formatter renders what it has, so a payload written by an older worker
 * version still produces a sane message.
 */
export interface NotificationPayload {
  triggerId?: string;
  ruleId?: string;
  ruleName?: string | null;
  side?: string;
  price?: number;
  size?: number;
  orderType?: string;
  bestBid?: number | null;
  bestAsk?: number | null;
  filledSize?: string;
  avgFillPrice?: string | null;
  amountUsd?: string;
  intentId?: string;
}

export interface FormattedMessage {
  html: string;
  buttons: TelegramInlineButton[][];
}

const orderLine = (p: NotificationPayload): string => {
  const side = (p.side ?? "").toUpperCase();
  const mode = p.orderType ? ` · ${p.orderType}` : "";
  return `${escapeHtml(side)} ${formatSize(p.size)} @ ${formatCents(p.price)}${mode}`;
};

const bookLine = (p: NotificationPayload): string | null => {
  if (p.bestBid == null && p.bestAsk == null) return null;
  return `Book: ${formatCents(p.bestBid)} bid / ${formatCents(p.bestAsk)} ask`;
};

const nameLine = (p: NotificationPayload): string | null =>
  p.ruleName ? escapeHtml(p.ruleName) : null;

export const formatNotification = (
  kind: NotificationKind,
  payload: NotificationPayload,
  opts: {
    appBaseUrl: string;
    /** Tokenized mobile sign URL (order_awaiting_signature only). */
    signUrl?: string;
    /**
     * Token-free Mini App URL (order_awaiting_signature only). When present,
     * the primary button opens inside Telegram (auth via initData) and the
     * tokenized signUrl demotes to an "Open in browser" fallback — the escape
     * hatch when WalletConnect deep-linking misbehaves in the webview.
     */
    miniappSignUrl?: string;
  },
): FormattedMessage => {
  const base = opts.appBaseUrl.replace(/\/$/, "");
  const lines: (string | null)[] = [];
  const buttons: TelegramInlineButton[][] = [];

  switch (kind) {
    case "order_awaiting_signature": {
      lines.push("🖊 <b>Order ready to sign</b>", nameLine(payload), orderLine(payload));
      lines.push(bookLine(payload));
      lines.push("The prepared order waits for your wallet signature.");
      if (opts.miniappSignUrl) {
        buttons.push([{ text: "Open & sign", web_app: { url: opts.miniappSignUrl } }]);
      }
      if (opts.signUrl) {
        buttons.push([
          { text: opts.miniappSignUrl ? "Open in browser" : "Open & sign", url: opts.signUrl },
        ]);
      }
      if (payload.triggerId) {
        buttons.push([{ text: "Dismiss", callback_data: `dismiss:${payload.triggerId}` }]);
      }
      break;
    }
    case "rule_alert": {
      lines.push("🔔 <b>Alert triggered</b>", nameLine(payload), bookLine(payload));
      if (payload.ruleId) {
        buttons.push([{ text: "Open strategy", url: `${base}/smart-orders/${payload.ruleId}` }]);
      }
      break;
    }
    case "order_auto_executed": {
      lines.push("⚡️ <b>Order auto-executed</b>", nameLine(payload), orderLine(payload));
      if (payload.ruleId) {
        buttons.push([{ text: "Open strategy", url: `${base}/smart-orders/${payload.ruleId}` }]);
      }
      break;
    }
    case "order_filled": {
      const avg =
        payload.avgFillPrice != null ? ` @ ${formatCents(Number(payload.avgFillPrice))}` : "";
      lines.push(
        "✅ <b>Order filled</b>",
        `${escapeHtml((payload.side ?? "").toUpperCase())} ${formatSize(
          Number(payload.filledSize ?? payload.size),
        )}${avg}`,
      );
      buttons.push([{ text: "Open portfolio", url: `${base}/portfolio` }]);
      break;
    }
    case "deposit_completed": {
      lines.push("💰 <b>Deposit completed</b>", "Funds arrived in your trading wallet.");
      buttons.push([{ text: "Open wallet", url: `${base}/wallet` }]);
      break;
    }
    case "withdrawal_completed": {
      lines.push("🏦 <b>Withdrawal completed</b>");
      buttons.push([{ text: "Open wallet", url: `${base}/wallet` }]);
      break;
    }
    case "auto_retry_abandoned": {
      lines.push(
        "⚠️ <b>Auto-execution needs you</b>",
        nameLine(payload),
        "The automatic retry gave up — confirm or dismiss the trigger manually.",
      );
      if (payload.ruleId) {
        buttons.push([{ text: "Open strategy", url: `${base}/smart-orders/${payload.ruleId}` }]);
      }
      break;
    }
  }

  return {
    html: lines.filter((l): l is string => l !== null && l !== "").join("\n"),
    buttons,
  };
};
