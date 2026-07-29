import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionStore } from "@mx2/db";
import { makeRequireAuth } from "./require-auth.js";
import type {} from "../auth/types.js";

export interface RequireAdminDeps {
  sessions: SessionStore;
  /** Lowercased EOAs from ADMIN_WALLET_ADDRESSES. */
  adminWallets: string[];
}

/**
 * Admin gate for the /api/admin/panel/* routes: a normal (full) wallet session
 * whose wallet is in the configured admin set. Unlike the x-admin-secret
 * header routes, every action is attributable to a specific wallet in the
 * audit log. An empty admin set fails closed (403 for everyone).
 */
export const makeRequireAdminWallet = ({ sessions, adminWallets }: RequireAdminDeps) => {
  const requireAuth = makeRequireAuth({ sessions });
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const wallet = req.user?.walletAddress;
    if (!wallet || !adminWallets.includes(wallet.toLowerCase())) {
      await reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
    }
  };
};
