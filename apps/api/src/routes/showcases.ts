import type { FastifyInstance } from "fastify";
import type { ClobClient, GammaClient } from "@mx2/polymarket-client";
import { makeRateLimit } from "../middleware/rate-limit.js";
import { getShowcases } from "../lib/showcases.js";

export interface ShowcasesRoutesDeps {
  gammaClient: GammaClient;
  clobClient: ClobClient;
}

export const registerShowcasesRoutes = (app: FastifyInstance, deps: ShowcasesRoutesDeps): void => {
  // PUBLIC, rate-limited, served from a 15-minute in-memory cache. Read-only
  // marketing data (like the feed) — no auth, no flag.
  app.get(
    "/api/showcases",
    { preHandler: [makeRateLimit({ scope: "showcases", limit: 30, windowMs: 60_000 })] },
    async (req, reply) => {
      try {
        return await getShowcases(
          { gammaClient: deps.gammaClient, clobClient: deps.clobClient },
          req.log,
        );
      } catch (err) {
        req.log.warn({ err }, "showcases: unavailable (no cache, refresh failed)");
        reply.code(502);
        return { error: "UPSTREAM_ERROR", message: "Could not build showcases right now." };
      }
    },
  );
};
