/**
 * Minimal Discord REST client for DM delivery (no gateway, no SDK). Bots can
 * DM only users who share a guild — the linking UI points users at the
 * project guild invite. The bot token is SENSITIVE: failures surface as
 * token-free descriptions only.
 */

export interface DiscordSendResult {
  ok: boolean;
  description?: string;
}

export interface DiscordApi {
  sendDirectMessage(opts: {
    /** Discord user id (from the OAuth identify handshake). */
    userId: string;
    content: string;
    linkButtons?: { label: string; url: string }[];
  }): Promise<DiscordSendResult>;
}

export const createDiscordApi = (opts: {
  botToken: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): DiscordApi => {
  const baseUrl = opts.baseUrl ?? "https://discord.com/api/v10";
  const fetchFn = opts.fetchFn ?? fetch;
  /** DM channel ids are stable per user — cache to halve the REST calls. */
  const dmChannelByUser = new Map<string, string>();

  const call = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; json: unknown; status: number }> => {
    try {
      const res = await fetchFn(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bot ${opts.botToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const json: unknown = await res.json().catch(() => null);
      return { ok: res.ok, json, status: res.status };
    } catch (error) {
      return {
        ok: false,
        json: { message: error instanceof Error ? error.message : "discord request failed" },
        status: 0,
      };
    }
  };

  return {
    async sendDirectMessage({ userId, content, linkButtons }) {
      let channelId = dmChannelByUser.get(userId);
      if (!channelId) {
        const dm = await call("/users/@me/channels", { recipient_id: userId });
        const id = (dm.json as { id?: string } | null)?.id;
        if (!dm.ok || !id) {
          return {
            ok: false,
            description: `createDM failed (${dm.status}): ${
              (dm.json as { message?: string } | null)?.message ?? "unknown"
            }`,
          };
        }
        channelId = id;
        dmChannelByUser.set(userId, channelId);
      }

      const components =
        linkButtons && linkButtons.length > 0
          ? [
              {
                type: 1, // action row
                components: linkButtons.slice(0, 5).map((b) => ({
                  type: 2, // button
                  style: 5, // link
                  label: b.label,
                  url: b.url,
                })),
              },
            ]
          : undefined;
      const sent = await call(`/channels/${channelId}/messages`, {
        content,
        ...(components ? { components } : {}),
      });
      if (!sent.ok) {
        // A stale cached DM channel would 404 — drop it so the next attempt
        // re-creates the channel instead of failing forever.
        if (sent.status === 404) dmChannelByUser.delete(userId);
        return {
          ok: false,
          description: `sendMessage failed (${sent.status}): ${
            (sent.json as { message?: string } | null)?.message ?? "unknown"
          }`,
        };
      }
      return { ok: true };
    },
  };
};
