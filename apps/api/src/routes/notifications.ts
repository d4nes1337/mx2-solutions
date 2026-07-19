import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "@mx2/config";
import {
  NOTIFICATION_KINDS,
  type AuditStore,
  type LinkCodeStore,
  type NotificationChannelKind,
  type NotificationChannelRow,
  type NotificationChannelStore,
  type SessionStore,
} from "@mx2/db";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeRateLimit } from "../middleware/rate-limit.js";
import type { DiscordOauthClient } from "../lib/discord-oauth.js";

/**
 * Notification channel management (Telegram/Discord linking). The link
 * handshake is code-based: the authenticated wallet mints a single-use code
 * here; presenting it to the bot (/start <code>) proves the external account
 * and the wallet belong to the same person. The DB only ever stores
 * SHA256(code) — the raw code lives in the deep link alone.
 */

export interface NotificationsRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  notificationChannels: NotificationChannelStore;
  linkCodes: LinkCodeStore;
  /** Discord OAuth exchange (FEATURE_DISCORD_BOT); injected fake in tests. */
  discordOauth?: DiscordOauthClient;
}

export const LINK_CODE_TTL_MS = 10 * 60_000;

const LinkCodeSchema = z.object({ channel: z.enum(["telegram", "discord"]) }).strict();

const PreferencesSchema = z
  .object({
    preferences: z.record(z.enum(NOTIFICATION_KINDS), z.boolean()),
  })
  .strict();

const serializeChannel = (row: NotificationChannelRow) => ({
  id: row.id,
  channel: row.channel,
  externalUsername: row.externalUsername,
  status: row.status,
  preferences: row.preferences,
  createdAt: row.createdAt,
});

export const registerNotificationsRoutes = (
  app: FastifyInstance,
  deps: NotificationsRoutesDeps,
): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  const requireEnabled = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.config.features.notifications) {
      await reply.code(503).send({
        error: "NOTIFICATIONS_DISABLED",
        message: "Notifications are disabled on this server.",
      });
    }
  };
  const guard = { preHandler: [requireAuth, requireEnabled] };

  const channelEnabled = (channel: NotificationChannelKind): boolean =>
    channel === "telegram" ? deps.config.features.telegramBot : deps.config.features.discordBot;

  const linkCodeRateLimit = makeRateLimit({ limit: 10, windowMs: 60_000, scope: "notif-link" });

  app.post(
    "/api/notifications/link-code",
    { preHandler: [requireAuth, requireEnabled, linkCodeRateLimit] },
    async (req, reply) => {
      const user = req.user!;
      const parsed = LinkCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "channel must be telegram or discord." };
      }
      const { channel } = parsed.data;
      if (!channelEnabled(channel)) {
        reply.code(503);
        return {
          error: "CHANNEL_DISABLED",
          message: `The ${channel} channel is not enabled on this server.`,
        };
      }

      // base64url of 24 bytes = 32 chars from [A-Za-z0-9_-], valid as a
      // t.me ?start= payload (Telegram caps it at 64 chars).
      const code = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
      await deps.linkCodes.create({
        codeHash: createHash("sha256").update(code, "utf8").digest("hex"),
        walletAddress: user.walletAddress,
        channel,
        expiresAt,
      });
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "notification.channel_link_requested",
        subject: `wallet:${user.walletAddress}`,
        metadata: { channel },
      });

      const botUsername = deps.config.notifications.telegramBotUsername;
      return {
        code,
        expiresAt: expiresAt.toISOString(),
        deepLink:
          channel === "telegram" && botUsername
            ? `https://t.me/${botUsername}?start=${code}`
            : null,
        guildInviteUrl:
          channel === "discord" ? (deps.config.notifications.discordGuildInviteUrl ?? null) : null,
      };
    },
  );

  // ── Discord linking (OAuth2 identify) ──────────────────────────────────────
  // The state parameter IS a single-use link code minted for the logged-in
  // wallet — the callback consumes it, so an attacker cannot splice their
  // Discord account onto someone else's wallet (CSRF-safe by construction).
  if (deps.discordOauth && deps.config.features.discordBot) {
    const discordOauth = deps.discordOauth;
    const clientId = deps.config.notifications.discordClientId ?? "";
    const redirectUri = `${deps.config.baseUrl.replace(/\/$/, "")}/api/notifications/discord/callback`;

    app.get("/api/notifications/discord/oauth-url", guard, async (req) => {
      const user = req.user!;
      const state = randomBytes(24).toString("base64url");
      await deps.linkCodes.create({
        codeHash: createHash("sha256").update(state, "utf8").digest("hex"),
        walletAddress: user.walletAddress,
        channel: "discord",
        expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
      });
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "notification.channel_link_requested",
        subject: `wallet:${user.walletAddress}`,
        metadata: { channel: "discord" },
      });
      const url =
        "https://discord.com/oauth2/authorize?" +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "identify",
          state,
          prompt: "consent",
        }).toString();
      return {
        url,
        guildInviteUrl: deps.config.notifications.discordGuildInviteUrl ?? null,
      };
    });

    const callbackRateLimit = makeRateLimit({ limit: 10, windowMs: 60_000, scope: "discord-cb" });
    app.get(
      "/api/notifications/discord/callback",
      { preHandler: [callbackRateLimit] },
      async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const code = q["code"];
        const state = q["state"];
        const bounce = (result: "linked" | "error") =>
          reply.redirect(`${deps.config.baseUrl.replace(/\/$/, "")}/wallet?discord=${result}`);
        if (!code || !state || state.length > 128) return bounce("error");
        const consumed = await deps.linkCodes.consume(
          createHash("sha256").update(state, "utf8").digest("hex"),
        );
        if (!consumed || consumed.channel !== "discord") return bounce("error");
        const identity = await discordOauth.exchangeCode(code, redirectUri);
        if (!identity) return bounce("error");
        const channel = await deps.notificationChannels.link({
          walletAddress: consumed.walletAddress,
          channel: "discord",
          externalId: identity.id,
          externalUsername: identity.username,
        });
        await deps.auditStore.emit({
          actor: consumed.walletAddress,
          action: "notification.channel_linked",
          subject: `notification_channel:${channel.id}`,
          metadata: { channel: "discord" },
        });
        return bounce("linked");
      },
    );
  }

  app.get("/api/notifications/channels", guard, async (req) => {
    const user = req.user!;
    const rows = await deps.notificationChannels.listActiveByWallet(user.walletAddress);
    return {
      channels: rows.map(serializeChannel),
      kinds: NOTIFICATION_KINDS,
      telegramEnabled: deps.config.features.telegramBot,
      discordEnabled: deps.config.features.discordBot,
    };
  });

  app.patch("/api/notifications/channels/:id", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: "preferences must map known notification kinds to booleans.",
      };
    }
    const row = await deps.notificationChannels.updatePreferences(
      id,
      user.walletAddress,
      parsed.data.preferences,
    );
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Notification channel not found." };
    }
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "notification.preferences_updated",
      subject: `notification_channel:${row.id}`,
      metadata: { channel: row.channel, preferences: parsed.data.preferences },
    });
    return serializeChannel(row);
  });

  app.delete("/api/notifications/channels/:id", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const row = await deps.notificationChannels.revoke(id, user.walletAddress);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Notification channel not found." };
    }
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "notification.channel_unlinked",
      subject: `notification_channel:${row.id}`,
      metadata: { channel: row.channel },
    });
    return { ok: true };
  });
};
