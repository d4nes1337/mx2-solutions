import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { loadConfig } from "@mx2/config";
import type {
  AuditStore,
  ChannelLinkCodeRow,
  LinkCodeStore,
  NotificationChannelRow,
  NotificationChannelStore,
  SessionStore,
} from "@mx2/db";
import { resetRateLimits } from "../middleware/rate-limit.js";
import type { DiscordOauthClient } from "../lib/discord-oauth.js";
import { registerNotificationsRoutes } from "./notifications.js";

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const COOKIE = "mx2_session=tok";

const makeSessions = (scope: unknown = null): SessionStore => ({
  create: async () => {
    throw new Error("no");
  },
  findByTokenHash: async () => ({
    id: "s1",
    userWallet: WALLET,
    tokenHash: "h",
    expiresAt: new Date(Date.now() + 1_000_000),
    scope,
    createdAt: new Date(),
    revokedAt: null,
  }),
  revoke: async () => {},
});

const makeAuditStore = (): AuditStore & { actions: string[] } => {
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

const makeChannelStore = (): NotificationChannelStore & { rows: NotificationChannelRow[] } => {
  const rows: NotificationChannelRow[] = [];
  return {
    rows,
    link: async ({ walletAddress, channel, externalId, externalUsername }) => {
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
    findByIdForWallet: async (id, w) =>
      rows.find((r) => r.id === id && r.walletAddress === w) ?? null,
    revoke: async (id, w) => {
      const row = rows.find((r) => r.id === id && r.walletAddress === w && r.status === "active");
      if (!row) return null;
      row.status = "revoked";
      return row;
    },
    revokeByExternalId: async () => null,
    updatePreferences: async (id, w, preferences) => {
      const row = rows.find((r) => r.id === id && r.walletAddress === w && r.status === "active");
      if (!row) return null;
      row.preferences = preferences;
      return row;
    },
  };
};

const makeLinkCodeStore = (): LinkCodeStore & { created: ChannelLinkCodeRow[] } => {
  const created: ChannelLinkCodeRow[] = [];
  return {
    created,
    create: async ({ codeHash, walletAddress, channel, expiresAt }) => {
      const row: ChannelLinkCodeRow = {
        id: `code-${created.length + 1}`,
        codeHash,
        walletAddress,
        channel,
        expiresAt,
        usedAt: null,
        createdAt: new Date(),
      };
      created.push(row);
      return row;
    },
    consume: async (codeHash) => {
      const row = created.find(
        (c) => c.codeHash === codeHash && c.usedAt === null && c.expiresAt > new Date(),
      );
      if (!row) return null;
      row.usedAt = new Date();
      return row;
    },
  };
};

const enabledEnv = {
  FEATURE_NOTIFICATIONS: "true",
  FEATURE_TELEGRAM_BOT: "true",
  TELEGRAM_BOT_TOKEN: "123:test-token",
  TELEGRAM_BOT_USERNAME: "mx2_test_bot",
} as NodeJS.ProcessEnv;

const discordEnv = {
  ...enabledEnv,
  FEATURE_DISCORD_BOT: "true",
  DISCORD_BOT_TOKEN: "discord-bot-token",
  DISCORD_CLIENT_ID: "client-123",
  DISCORD_CLIENT_SECRET: "secret-456",
  DISCORD_GUILD_INVITE_URL: "https://discord.gg/example",
} as NodeJS.ProcessEnv;

interface TestCtx {
  app: FastifyInstance;
  auditStore: ReturnType<typeof makeAuditStore>;
  channels: ReturnType<typeof makeChannelStore>;
  linkCodes: ReturnType<typeof makeLinkCodeStore>;
}

const makeApp = async (
  env: NodeJS.ProcessEnv = enabledEnv,
  scope: unknown = null,
  discordOauth?: DiscordOauthClient,
): Promise<TestCtx> => {
  const app = Fastify();
  await app.register(fastifyCookie);
  app.decorateRequest("user", null);
  const auditStore = makeAuditStore();
  const channels = makeChannelStore();
  const linkCodes = makeLinkCodeStore();
  registerNotificationsRoutes(app as unknown as FastifyInstance, {
    config: loadConfig(env),
    sessions: makeSessions(scope),
    auditStore,
    notificationChannels: channels,
    linkCodes,
    ...(discordOauth ? { discordOauth } : {}),
  });
  return { app: app as unknown as FastifyInstance, auditStore, channels, linkCodes };
};

beforeEach(() => resetRateLimits());

describe("POST /api/notifications/link-code", () => {
  it("503s when notifications are disabled", async () => {
    const { app } = await makeApp({} as NodeJS.ProcessEnv);
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/link-code",
      headers: { cookie: COOKIE },
      payload: { channel: "telegram" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("NOTIFICATIONS_DISABLED");
  });

  it("503s for a channel whose bot is not enabled", async () => {
    const { app } = await makeApp({ FEATURE_NOTIFICATIONS: "true" } as NodeJS.ProcessEnv);
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/link-code",
      headers: { cookie: COOKIE },
      payload: { channel: "telegram" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("CHANNEL_DISABLED");
  });

  it("mints a single-use code and a t.me deep link; stores only the hash", async () => {
    const { app, auditStore, linkCodes } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/link-code",
      headers: { cookie: COOKIE },
      payload: { channel: "telegram" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: string; deepLink: string; expiresAt: string };
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(body.deepLink).toBe(`https://t.me/mx2_test_bot?start=${body.code}`);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The DB never sees the raw code.
    expect(linkCodes.created).toHaveLength(1);
    expect(linkCodes.created[0]!.codeHash).not.toBe(body.code);
    expect(linkCodes.created[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(auditStore.actions).toContain("notification.channel_link_requested");
  });

  it("401s without a session", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/link-code",
      payload: { channel: "telegram" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("401s for a scoped (sign-link) session — fail-closed", async () => {
    const { app } = await makeApp(enabledEnv, { type: "trigger", triggerId: "t1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/link-code",
      headers: { cookie: COOKIE },
      payload: { channel: "telegram" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/notifications/channels", () => {
  it("lists active channels without leaking the external id", async () => {
    const { app, channels } = await makeApp();
    await channels.link({
      walletAddress: WALLET,
      channel: "telegram",
      externalId: "12345",
      externalUsername: "alice",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/channels",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      channels: Record<string, unknown>[];
      kinds: string[];
      telegramEnabled: boolean;
    };
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]!.externalUsername).toBe("alice");
    expect(body.channels[0]!.externalId).toBeUndefined();
    expect(body.kinds).toContain("order_awaiting_signature");
    expect(body.telegramEnabled).toBe(true);
  });
});

describe("PATCH /api/notifications/channels/:id", () => {
  it("rejects unknown kinds", async () => {
    const { app, channels } = await makeApp();
    const row = await channels.link({
      walletAddress: WALLET,
      channel: "telegram",
      externalId: "12345",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/notifications/channels/${row.id}`,
      headers: { cookie: COOKIE },
      payload: { preferences: { bogus_kind: false } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("updates per-kind opt-outs", async () => {
    const { app, channels, auditStore } = await makeApp();
    const row = await channels.link({
      walletAddress: WALLET,
      channel: "telegram",
      externalId: "12345",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/notifications/channels/${row.id}`,
      headers: { cookie: COOKIE },
      payload: { preferences: { order_filled: false } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { preferences: Record<string, boolean> }).preferences).toEqual({
      order_filled: false,
    });
    expect(auditStore.actions).toContain("notification.preferences_updated");
  });
});

describe("DELETE /api/notifications/channels/:id", () => {
  it("revokes an owned channel and audits", async () => {
    const { app, channels, auditStore } = await makeApp();
    const row = await channels.link({
      walletAddress: WALLET,
      channel: "telegram",
      externalId: "12345",
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/notifications/channels/${row.id}`,
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(channels.rows[0]!.status).toBe("revoked");
    expect(auditStore.actions).toContain("notification.channel_unlinked");
  });

  it("404s for a channel the wallet does not own", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/notifications/channels/nope",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Discord OAuth linking", () => {
  const fakeOauth = (
    identity: { id: string; username: string | null } | null,
  ): DiscordOauthClient => ({
    exchangeCode: async () => identity,
  });

  it("mints an authorize URL whose state is a hashed single-use link code", async () => {
    const { app, linkCodes } = await makeApp(discordEnv, null, fakeOauth(null));
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/discord/oauth-url",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; guildInviteUrl: string | null };
    expect(body.url).toContain("https://discord.com/oauth2/authorize?");
    expect(body.url).toContain("client_id=client-123");
    expect(body.url).toContain("scope=identify");
    expect(body.guildInviteUrl).toBe("https://discord.gg/example");
    const state = new URL(body.url).searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Stored hashed, bound to the discord channel + logged-in wallet.
    expect(linkCodes.created[0]!.codeHash).not.toBe(state);
    expect(linkCodes.created[0]!.channel).toBe("discord");
    expect(linkCodes.created[0]!.walletAddress).toBe(WALLET);
  });

  it("callback consumes the state, links the identity, and bounces to the wallet page", async () => {
    const { app, channels, auditStore } = await makeApp(
      discordEnv,
      null,
      fakeOauth({ id: "dc-9", username: "alice" }),
    );
    const minted = await app.inject({
      method: "GET",
      url: "/api/notifications/discord/oauth-url",
      headers: { cookie: COOKIE },
    });
    const state = new URL((minted.json() as { url: string }).url).searchParams.get("state")!;

    const cb = await app.inject({
      method: "GET",
      url: `/api/notifications/discord/callback?code=oauth-code&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("/wallet?discord=linked");
    expect(channels.rows[0]).toMatchObject({
      walletAddress: WALLET,
      channel: "discord",
      externalId: "dc-9",
      externalUsername: "alice",
    });
    expect(auditStore.actions).toContain("notification.channel_linked");

    // Replayed state is single-use → error bounce, no second link.
    const replay = await app.inject({
      method: "GET",
      url: `/api/notifications/discord/callback?code=oauth-code&state=${state}`,
    });
    expect(replay.headers.location).toContain("/wallet?discord=error");
    expect(channels.rows).toHaveLength(1);
  });

  it("callback bounces to error when the OAuth exchange fails (no link)", async () => {
    const { app, channels } = await makeApp(discordEnv, null, fakeOauth(null));
    const minted = await app.inject({
      method: "GET",
      url: "/api/notifications/discord/oauth-url",
      headers: { cookie: COOKIE },
    });
    const state = new URL((minted.json() as { url: string }).url).searchParams.get("state")!;
    const cb = await app.inject({
      method: "GET",
      url: `/api/notifications/discord/callback?code=bad&state=${state}`,
    });
    expect(cb.headers.location).toContain("/wallet?discord=error");
    expect(channels.rows).toHaveLength(0);
  });

  it("discord routes are absent when the flag is off", async () => {
    const { app } = await makeApp(enabledEnv, null, fakeOauth(null));
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/discord/oauth-url",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(404);
  });
});
