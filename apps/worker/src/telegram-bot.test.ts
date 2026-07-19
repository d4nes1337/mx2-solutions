import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  ChannelLinkCodeRow,
  LinkCodeStore,
  NotificationChannelRow,
  NotificationChannelStore,
  RuleTriggerRow,
  SignLinkTokenStore,
  TriggerStore,
} from "@mx2/db";
import type { SendResult, TelegramApi } from "./telegram/api.js";
import { createTelegramBot } from "./telegram-bot.js";

const logger = createLogger({ name: "telegram-bot-test", level: "silent" });
const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const CHAT = "424242";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface Recorded {
  chatId: string;
  html: string;
  buttons?: unknown;
}

const makeApi = (): TelegramApi & { sent: Recorded[]; answered: string[] } => {
  const sent: Recorded[] = [];
  const answered: string[] = [];
  return {
    sent,
    answered,
    sendMessage: async ({ chatId, html, buttons }): Promise<SendResult> => {
      sent.push({ chatId, html, buttons });
      return { ok: true };
    },
    getUpdates: async () => [],
    answerCallbackQuery: async (_id, text) => {
      answered.push(text ?? "");
    },
    editMessageReplyMarkup: async () => {},
  };
};

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

const makeChannels = (
  initial: NotificationChannelRow[] = [],
): NotificationChannelStore & { rows: NotificationChannelRow[] } => {
  const rows = [...initial];
  return {
    rows,
    link: async ({ walletAddress, channel, externalId, externalUsername }) => {
      for (const r of rows) {
        if (r.channel === channel && r.externalId === externalId && r.status === "active") {
          r.status = "revoked";
        }
      }
      const row: NotificationChannelRow = {
        id: `ch-${rows.length + 1}`,
        walletAddress,
        channel,
        externalId,
        externalUsername: externalUsername ?? null,
        status: "active",
        preferences: {},
        createdAt: new Date(),
        revokedAt: null,
      };
      rows.push(row);
      return row;
    },
    listActiveByWallet: async (w) =>
      rows.filter((r) => r.walletAddress === w && r.status === "active"),
    findActiveByExternalId: async (channel, externalId) =>
      rows.find(
        (r) => r.channel === channel && r.externalId === externalId && r.status === "active",
      ) ?? null,
    findByIdForWallet: async () => null,
    revoke: async () => null,
    revokeByExternalId: async (channel, externalId) => {
      const row = rows.find(
        (r) => r.channel === channel && r.externalId === externalId && r.status === "active",
      );
      if (!row) return null;
      row.status = "revoked";
      return row;
    },
    updatePreferences: async () => null,
  };
};

const makeLinkCodes = (codes: ChannelLinkCodeRow[]): LinkCodeStore => ({
  create: async () => {
    throw new Error("not used");
  },
  consume: async (codeHash) => {
    const row = codes.find(
      (c) => c.codeHash === codeHash && c.usedAt === null && c.expiresAt > new Date(),
    );
    if (!row) return null;
    row.usedAt = new Date();
    return row;
  },
});

const makeSignTokens = (): SignLinkTokenStore & { created: number } => {
  const state = { created: 0 };
  return {
    get created() {
      return state.created;
    },
    create: async ({ tokenHash, walletAddress, triggerId, expiresAt }) => {
      state.created += 1;
      return {
        id: `tok-${state.created}`,
        tokenHash,
        walletAddress,
        triggerId,
        expiresAt,
        usedAt: null,
        createdAt: new Date(),
      };
    },
    consume: async () => null,
  };
};

const makeTrigger = (over: Partial<RuleTriggerRow> = {}): RuleTriggerRow => ({
  id: "trig-1",
  ruleId: "rule-1",
  walletAddress: WALLET,
  triggeredAt: new Date(),
  evidence: { bestBid: 0.44, bestAsk: 0.46 },
  reasonCodes: [],
  status: "awaiting_user",
  orderIntentId: null,
  createdAt: new Date(),
  ...over,
});

const makeTriggerStore = (
  triggers: RuleTriggerRow[],
): TriggerStore & { statusUpdates: [string, string][] } => {
  const statusUpdates: [string, string][] = [];
  return {
    statusUpdates,
    create: async () => {
      throw new Error("not used");
    },
    findById: async (id) => triggers.find((t) => t.id === id) ?? null,
    findByIdForWallet: async (id, wallet) =>
      triggers.find((t) => t.id === id && t.walletAddress === wallet) ?? null,
    listByWallet: async () => triggers,
    listAwaiting: async (wallet) =>
      triggers.filter((t) => t.walletAddress === wallet && t.status === "awaiting_user"),
    listByRule: async () => [],
    hasForRule: async () => false,
    updateStatus: async (id, status) => {
      statusUpdates.push([id, status]);
      const t = triggers.find((x) => x.id === id);
      if (t) t.status = status;
    },
  };
};

const activeChannel = (): NotificationChannelRow => ({
  id: "ch-1",
  walletAddress: WALLET,
  channel: "telegram",
  externalId: CHAT,
  externalUsername: "alice",
  status: "active",
  preferences: {},
  createdAt: new Date(),
  revokedAt: null,
});

const makeBot = (opts: {
  channels?: NotificationChannelStore;
  linkCodes?: LinkCodeStore;
  triggers?: RuleTriggerRow[];
}) => {
  const api = makeApi();
  const audit = makeAudit();
  const signTokens = makeSignTokens();
  const triggerStore = makeTriggerStore(opts.triggers ?? []);
  const channels = opts.channels ?? makeChannels();
  const bot = createTelegramBot({
    logger,
    api,
    channels,
    linkCodes: opts.linkCodes ?? makeLinkCodes([]),
    triggerStore,
    signTokens,
    auditStore: audit,
    appBaseUrl: "https://app.example.com",
  });
  return { bot, api, audit, signTokens, triggerStore, channels };
};

const messageUpdate = (text: string) => ({
  update_id: 1,
  message: {
    message_id: 10,
    chat: { id: Number(CHAT), type: "private" },
    from: { id: 7, username: "alice" },
    text,
  },
});

describe("/start <code>", () => {
  it("consumes a valid code, links the chat, audits, and confirms", async () => {
    const code = "valid-code-123";
    const linkCodes = makeLinkCodes([
      {
        id: "lc-1",
        codeHash: sha256(code),
        walletAddress: WALLET,
        channel: "telegram",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        createdAt: new Date(),
      },
    ]);
    const channelStore = makeChannels();
    const { bot, api, audit } = makeBot({ channels: channelStore, linkCodes });
    await bot.handleUpdate(messageUpdate(`/start ${code}`));
    expect(channelStore.rows).toHaveLength(1);
    expect(channelStore.rows[0]).toMatchObject({
      walletAddress: WALLET,
      externalId: CHAT,
      externalUsername: "alice",
      status: "active",
    });
    expect(audit.actions).toContain("notification.channel_linked");
    expect(api.sent[0]!.html).toContain("Linked");
  });

  it("rejects an unknown/expired code without linking", async () => {
    const channelStore = makeChannels();
    const { bot, api } = makeBot({ channels: channelStore });
    await bot.handleUpdate(messageUpdate("/start bogus"));
    expect(channelStore.rows).toHaveLength(0);
    expect(api.sent[0]!.html).toContain("invalid or expired");
  });
});

describe("/unlink", () => {
  it("revokes the chat's channel and audits", async () => {
    const channelStore = makeChannels([activeChannel()]);
    const { bot, audit } = makeBot({ channels: channelStore });
    await bot.handleUpdate(messageUpdate("/unlink"));
    expect(channelStore.rows[0]!.status).toBe("revoked");
    expect(audit.actions).toContain("notification.channel_unlinked");
  });
});

describe("/orders", () => {
  it("re-sends each awaiting trigger with a fresh sign link", async () => {
    const channelStore = makeChannels([activeChannel()]);
    const { bot, api, signTokens } = makeBot({
      channels: channelStore,
      triggers: [makeTrigger(), makeTrigger({ id: "trig-2" })],
    });
    await bot.handleUpdate(messageUpdate("/orders"));
    expect(api.sent).toHaveLength(2);
    expect(signTokens.created).toBe(2);
    expect(JSON.stringify(api.sent[0]!.buttons)).toContain("/m/t/trig-1?t=");
  });

  it("tells an unlinked chat to link first", async () => {
    const { bot, api } = makeBot({ triggers: [makeTrigger()] });
    await bot.handleUpdate(messageUpdate("/orders"));
    expect(api.sent[0]!.html).toContain("isn't linked");
  });
});

describe("dismiss callback", () => {
  const callbackUpdate = (triggerId: string) => ({
    update_id: 2,
    callback_query: {
      id: "cb-1",
      from: { id: 7, username: "alice" },
      data: `dismiss:${triggerId}`,
      message: {
        message_id: 55,
        chat: { id: Number(CHAT), type: "private" },
      },
    },
  });

  it("dismisses an awaiting trigger owned by the linked wallet", async () => {
    const channelStore = makeChannels([activeChannel()]);
    const { bot, triggerStore, audit, api } = makeBot({
      channels: channelStore,
      triggers: [makeTrigger()],
    });
    await bot.handleUpdate(callbackUpdate("trig-1"));
    expect(triggerStore.statusUpdates).toEqual([["trig-1", "dismissed"]]);
    expect(audit.actions).toContain("rule.trigger.dismissed");
    expect(api.answered[0]).toBe("Dismissed.");
  });

  it("refuses when the chat is not linked (cannot dismiss others' triggers)", async () => {
    const { bot, triggerStore, api } = makeBot({ triggers: [makeTrigger()] });
    await bot.handleUpdate(callbackUpdate("trig-1"));
    expect(triggerStore.statusUpdates).toHaveLength(0);
    expect(api.answered[0]).toContain("Not available");
  });
});
