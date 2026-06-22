import type { FastifyRequest, FastifyReply } from "fastify";
import type { GeoblockClient } from "@mx2/polymarket-client";
import type { AuditStore } from "@mx2/db";

export interface GeoblockMiddlewareDeps {
  geoblockClient: GeoblockClient;
  auditStore: AuditStore;
}

const extractIp = (req: FastifyRequest): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() ?? req.ip;
  }
  return req.ip;
};

export const makeGeoblockCheck =
  (deps: GeoblockMiddlewareDeps) =>
  async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ip = extractIp(req);
    const result = await deps.geoblockClient.check(ip);

    if (!result.ok) {
      // Fail-closed: upstream error → treat as blocked.
      req.log.warn(
        { event: "geoblock.check.failed", ip, error: result.error },
        "Geoblock check failed — blocking request",
      );
      await deps.auditStore.emit({
        actor: ip,
        action: "geoblock.checked",
        subject: `ip:${ip}`,
        metadata: { status: "error", error: result.error.code },
      });
      reply.code(403);
      await reply.send({
        error: "GEO_BLOCKED",
        message: "Trading is not available in your region.",
      });
      return;
    }

    await deps.auditStore.emit({
      actor: ip,
      action: "geoblock.checked",
      subject: `ip:${ip}`,
      metadata: { status: result.value.status, country: result.value.country },
    });

    if (result.value.status === "blocked") {
      req.log.info(
        { event: "geoblock.blocked", ip, country: result.value.country },
        "IP blocked by geoblock",
      );
      reply.code(403);
      await reply.send({
        error: "GEO_BLOCKED",
        message: "Trading is not available in your region.",
        country: result.value.country,
      });
      return;
    }

    if (result.value.status === "close_only") {
      req.log.info(
        { event: "geoblock.close_only", ip, country: result.value.country },
        "IP in close-only region",
      );
      reply.code(403);
      await reply.send({
        error: "GEO_CLOSE_ONLY",
        message: "Only closing positions is permitted in your region.",
        country: result.value.country,
      });
      return;
    }
  };
