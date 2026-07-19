import { describe, expect, it } from "vitest";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  NotificationChannelRow,
  NotificationChannelStore,
  NotificationOutboxRow,
  NotificationOutboxStore,
  SignLinkTokenStore,
} from "@mx2/db";
import type { SendResult, TelegramApi } from "./telegram/api.js";
import { createNotificationDispatcher } from "./notification-dispatcher.js";

const logger = createLogger({ name: "dispatcher-test", level: "silent" });
const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

const makeAudit = (): AuditStore & { actions: string[] } => {
  const actions: string[] = [];
  return {
    actions,
    emit: async (e) => {
      actions.push(e.action);
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
};

const makeOutboxRow = (over: Partial<NotificationOutboxRow> = {}): NotificationOutboxRow => ({
  id: "out-1",
  walletAddress: WALLET,
  kind: "order_awaiting_signature",
  dedupeKey: "trigger:trig-1:sign",
  payload: { triggerId: "trig-1", side: "buy", price: 0.45, size: 100, orderType: "GTC" },
  status: "pending",
  attempts: 0,
  nextAttemptAt: new Date(),
  lastError: null,
  sentAt: null,
  createdAt: new Date(),
  ...over,
});

const makeOutbox = (
  rows: NotificationOutboxRow[],
): NotificationOutboxStore & {
  sentIds: string[];
  skipped: [string, string][];
  failed: string[];
} => {
  const sentIds: string[] = [];
  const skipped: [string, string][] = [];
  const failed: string[] = [];
  return {
    sentIds,
    skipped,
    failed,
    enqueue: async () => null,
    claimDue: async () => rows.filter((r) => r.status === "pending"),
    markSent: async (id) => {
      sentIds.push(id);
      const row = rows.find((r) => r.id === id);
      if (row) row.status = "sent";
    },
    markSkipped: async (id, reason) => {
      skipped.push([id, reason]);
      const row = rows.find((r) => r.id === id);
      if (row) row.status = "skipped";
    },
    markAttemptFailed: async (id) => {
      failed.push(id);
      const row = rows.find((r) => r.id === id);
      if (row) row.attempts += 1;
    },
  };
};

const channelRow = (preferences: Record<string, boolean> = {}): NotificationChannelRow => ({
  id: "ch-1",
  walletAddress: WALLET,
  channel: "telegram",
  externalId: "424242",
  externalUsername: "alice",
  status: "active",
  preferences,
  createdAt: new Date(),
  revokedAt: null,
});

const makeChannels = (rows: NotificationChannelRow[]): NotificationChannelStore => ({
  link: async () => {
    throw new Error("not used");
  },
  listActiveByWallet: async (w) => rows.filter((r) => r.walletAddress === w),
  findActiveByExternalId: async () => null,
  findByIdForWallet: async () => null,
  revoke: async () => null,
  revokeByExternalId: async () => null,
  updatePreferences: async () => null,
});

const makeSignTokens = (): SignLinkTokenStore & { created: number } => {
  const state = { created: 0 };
  return {
    get created() {
      return state.created;
    },
    create: async (opts) => {
      state.created += 1;
      return {
        id: `tok-${state.created}`,
        tokenHash: opts.tokenHash,
        walletAddress: opts.walletAddress,
        triggerId: opts.triggerId,
        expiresAt: opts.expiresAt,
        usedAt: null,
        createdAt: new Date(),
      };
    },
    consume: async () => null,
  };
};

const makeApi = (
  result: SendResult = { ok: true },
): TelegramApi & { sent: { chatId: string; html: string; buttons?: unknown }[] } => {
  const sent: { chatId: string; html: string; buttons?: unknown }[] = [];
  return {
    sent,
    sendMessage: async ({ chatId, html, buttons }) => {
      sent.push({ chatId, html, buttons });
      return result;
    },
    getUpdates: async () => [],
    answerCallbackQuery: async () => {},
    editMessageReplyMarkup: async () => {},
  };
};

const makeDispatcher = (opts: {
  rows: NotificationOutboxRow[];
  channels?: NotificationChannelRow[];
  sendResult?: SendResult;
  miniapp?: boolean;
  appBaseUrl?: string;
}) => {
  const api = makeApi(opts.sendResult);
  const outbox = makeOutbox(opts.rows);
  const audit = makeAudit();
  const signTokens = makeSignTokens();
  const dispatcher = createNotificationDispatcher({
    logger,
    api,
    outbox,
    channels: makeChannels(opts.channels ?? [channelRow()]),
    signTokens,
    auditStore: audit,
    appBaseUrl: opts.appBaseUrl ?? "https://app.example.com",
    ...(opts.miniapp !== undefined ? { miniapp: opts.miniapp } : {}),
  });
  return { dispatcher, api, outbox, audit, signTokens };
};

describe("notification dispatcher", () => {
  it("delivers a due row to the linked chat with a freshly minted sign link", async () => {
    const { dispatcher, api, outbox, audit, signTokens } = makeDispatcher({
      rows: [makeOutboxRow()],
    });
    await dispatcher.tick();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.chatId).toBe("424242");
    expect(JSON.stringify(api.sent[0]!.buttons)).toContain("/m/t/trig-1?t=");
    expect(signTokens.created).toBe(1);
    expect(outbox.sentIds).toEqual(["out-1"]);
    expect(audit.actions).toContain("notification.sent");
  });

  it("skips a wallet with no linked channel", async () => {
    const { dispatcher, api, outbox } = makeDispatcher({ rows: [makeOutboxRow()], channels: [] });
    await dispatcher.tick();
    expect(api.sent).toHaveLength(0);
    expect(outbox.skipped[0]![0]).toBe("out-1");
  });

  it("honors per-kind opt-outs (default-on, explicit false opts out)", async () => {
    const { dispatcher, api, outbox } = makeDispatcher({
      rows: [makeOutboxRow({ kind: "order_filled", dedupeKey: "fill:i1", payload: {} })],
      channels: [channelRow({ order_filled: false })],
    });
    await dispatcher.tick();
    expect(api.sent).toHaveLength(0);
    expect(outbox.skipped).toHaveLength(1);
  });

  it("records failed sends for backoff retry and audits the failure", async () => {
    const { dispatcher, outbox, audit } = makeDispatcher({
      rows: [makeOutboxRow()],
      sendResult: { ok: false, description: "chat not found" },
    });
    await dispatcher.tick();
    expect(outbox.failed).toEqual(["out-1"]);
    expect(outbox.sentIds).toHaveLength(0);
    expect(audit.actions).toContain("notification.send_failed");
  });

  it("miniapp mode adds a web_app button on https origins only", async () => {
    const withMiniapp = makeDispatcher({ rows: [makeOutboxRow()], miniapp: true });
    await withMiniapp.dispatcher.tick();
    expect(JSON.stringify(withMiniapp.api.sent[0]!.buttons)).toContain("web_app");

    const httpOrigin = makeDispatcher({
      rows: [makeOutboxRow()],
      miniapp: true,
      appBaseUrl: "http://localhost:3000",
    });
    await httpOrigin.dispatcher.tick();
    // Telegram rejects http web_app buttons — the dispatcher must omit them.
    expect(JSON.stringify(httpOrigin.api.sent[0]!.buttons)).not.toContain("web_app");
  });

  it("informational kinds go out without any sign token", async () => {
    const { dispatcher, api, signTokens } = makeDispatcher({
      rows: [
        makeOutboxRow({
          kind: "order_auto_executed",
          dedupeKey: "trigger:t2:auto",
          payload: { ruleId: "rule-2", side: "buy", price: 0.3, size: 10, orderType: "FOK" },
        }),
      ],
    });
    await dispatcher.tick();
    expect(api.sent).toHaveLength(1);
    expect(signTokens.created).toBe(0);
    expect(JSON.stringify(api.sent[0]!.buttons)).not.toContain("/m/t/");
  });
});
