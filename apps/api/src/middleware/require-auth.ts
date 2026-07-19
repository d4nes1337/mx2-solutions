import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionScope, SessionStore } from "@mx2/db";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../auth/session.js";
import type {} from "../auth/types.js";

export interface RequireAuthDeps {
  sessions: SessionStore;
}

/**
 * May this session's scope act on the given trigger? Full sessions (null
 * scope) always may; a sign-link session only on ITS trigger; a Mini App
 * session on any trigger of its wallet (the store lookups are wallet-bound).
 */
export const scopeAllowsTrigger = (
  scope: SessionScope | null | undefined,
  triggerId: string,
): boolean => {
  if (scope === null || scope === undefined) return true;
  if (scope.type === "trigger") return scope.triggerId === triggerId;
  return scope.type === "telegram_wallet";
};

export const makeRequireAuth =
  ({ sessions }: RequireAuthDeps) =>
  async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = req.cookies[SESSION_COOKIE_NAME];
    if (!token) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const session = await sessions.findByTokenHash(hashSessionToken(token));
    if (!session) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    // Fail-closed: restricted sessions (sign-link / Mini App) never pass the
    // general auth gate — only routes that opt in via the scoped middleware
    // accept them. A full browser session has scope = null.
    if (session.scope !== null && session.scope !== undefined) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    req.user = { walletAddress: session.userWallet };
  };

/**
 * Auth gate for the handful of routes that ALSO accept restricted sessions
 * (trigger preview / confirm / dismiss / the scoped order submit). Sets
 * req.authScope so the handler can enforce its per-scope constraints — every
 * handler using this MUST check scopeAllowsTrigger (or equivalent) itself.
 */
export const makeRequireScopedAuth =
  ({ sessions }: RequireAuthDeps) =>
  async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = req.cookies[SESSION_COOKIE_NAME];
    if (!token) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const session = await sessions.findByTokenHash(hashSessionToken(token));
    if (!session) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    req.user = { walletAddress: session.userWallet };
    req.authScope = (session.scope as SessionScope | null) ?? null;
  };
