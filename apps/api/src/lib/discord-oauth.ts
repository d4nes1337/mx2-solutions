/**
 * Minimal Discord OAuth2 (identify scope) client for account linking. No SDK:
 * two REST calls — code→token exchange, then /users/@me. The client secret is
 * SENSITIVE (docs/05) and must never appear in logs or errors.
 */

export interface DiscordIdentity {
  id: string;
  username: string | null;
}

export interface DiscordOauthClient {
  /** Exchange an authorization code; null on any failure (fail-closed). */
  exchangeCode(code: string, redirectUri: string): Promise<DiscordIdentity | null>;
}

export const createDiscordOauthClient = (opts: {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): DiscordOauthClient => {
  const baseUrl = opts.baseUrl ?? "https://discord.com/api/v10";
  const fetchFn = opts.fetchFn ?? fetch;

  return {
    async exchangeCode(code, redirectUri) {
      try {
        const tokenRes = await fetchFn(`${baseUrl}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
          }).toString(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!tokenRes.ok) return null;
        const token = (await tokenRes.json()) as { access_token?: string };
        if (!token.access_token) return null;

        const meRes = await fetchFn(`${baseUrl}/users/@me`, {
          headers: { authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) return null;
        const me = (await meRes.json()) as { id?: string | number; username?: string };
        if (me.id === undefined || me.id === null) return null;
        return {
          id: String(me.id),
          username: typeof me.username === "string" ? me.username : null,
        };
      } catch {
        return null;
      }
    },
  };
};
