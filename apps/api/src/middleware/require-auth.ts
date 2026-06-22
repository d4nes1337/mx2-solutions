import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionStore } from "@mx2/db";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../auth/session.js";
import type {} from "../auth/types.js";

export interface RequireAuthDeps {
  sessions: SessionStore;
}

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
    req.user = { walletAddress: session.userWallet };
  };
