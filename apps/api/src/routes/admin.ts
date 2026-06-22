import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { AuditStore, RuntimeFlagStore } from "@mx2/db";

export interface AdminRoutesDeps {
  config: AppConfig;
  auditStore: AuditStore;
  runtimeFlags: RuntimeFlagStore;
}

const ADMIN_FLAG_KEY = "trading_paused";

export const registerAdminRoutes = (app: FastifyInstance, deps: AdminRoutesDeps): void => {
  const requireAdminSecret = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const secret = deps.config.tradingAdminSecret;
    if (!secret) {
      reply.code(503);
      await reply.send({
        error: "ADMIN_NOT_CONFIGURED",
        message: "Admin endpoint is not configured.",
      });
      return;
    }
    const provided = req.headers["x-admin-secret"];
    if (provided !== secret) {
      reply.code(401);
      await reply.send({ error: "UNAUTHORIZED", message: "Invalid admin secret." });
      return;
    }
  };

  // GET /api/admin/trading/status — returns current runtime flag state.
  app.get("/api/admin/trading/status", { preHandler: requireAdminSecret }, async () => {
    const flag = await deps.runtimeFlags.get(ADMIN_FLAG_KEY);
    return {
      tradingPaused: flag?.value === "true",
      featureFlagEnabled: deps.config.features.liveTrading,
      updatedBy: flag?.updatedBy ?? null,
      updatedAt: flag?.updatedAt ?? null,
    };
  });

  // POST /api/admin/trading/pause — activates kill switch.
  app.post("/api/admin/trading/pause", { preHandler: requireAdminSecret }, async (req) => {
    const by = (req.headers["x-admin-actor"] as string | undefined) ?? "admin";
    await deps.runtimeFlags.set(ADMIN_FLAG_KEY, "true", by);
    await deps.auditStore.emit({
      actor: by,
      action: "kill_switch.toggled",
      subject: "system:trading",
      metadata: { flag: ADMIN_FLAG_KEY },
    });
    req.log.warn({ event: "admin.trading.paused", by }, "Trading PAUSED via kill switch");
    return { ok: true, tradingPaused: true };
  });

  // POST /api/admin/trading/resume — lifts kill switch.
  app.post("/api/admin/trading/resume", { preHandler: requireAdminSecret }, async (req) => {
    const by = (req.headers["x-admin-actor"] as string | undefined) ?? "admin";
    await deps.runtimeFlags.set(ADMIN_FLAG_KEY, "false", by);
    await deps.auditStore.emit({
      actor: by,
      action: "kill_switch.toggled",
      subject: "system:trading",
      metadata: { flag: ADMIN_FLAG_KEY },
    });
    req.log.info({ event: "admin.trading.resumed", by }, "Trading RESUMED via kill switch");
    return { ok: true, tradingPaused: false };
  });
};
