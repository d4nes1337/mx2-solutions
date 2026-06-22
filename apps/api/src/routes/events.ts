import type { FastifyInstance } from "fastify";
import type { GammaClient, ListEventsParams } from "@mx2/polymarket-client";

export interface EventsRoutesDeps {
  gammaClient: GammaClient;
}

export const registerEventsRoutes = (app: FastifyInstance, deps: EventsRoutesDeps): void => {
  app.get("/api/events", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const evtParams: ListEventsParams = {
      limit: q["limit"] !== undefined ? Number(q["limit"]) : 20,
      offset: q["offset"] !== undefined ? Number(q["offset"]) : 0,
    };
    if (q["active"] === "true") evtParams.active = true;
    else if (q["active"] === "false") evtParams.active = false;
    if (q["closed"] === "true") evtParams.closed = true;
    else if (q["closed"] === "false") evtParams.closed = false;
    const result = await deps.gammaClient.listEvents(evtParams);
    if (!result.ok) {
      const code = result.error.statusCode === 429 ? 429 : 502;
      reply.code(code);
      return { error: result.error.code, message: result.error.message };
    }
    return { events: result.value, count: result.value.length };
  });

  app.get("/api/events/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await deps.gammaClient.getEvent(id);
    if (!result.ok) {
      const code = result.error.statusCode === 404 ? 404 : 502;
      reply.code(code);
      return { error: result.error.code, message: result.error.message };
    }
    return result.value;
  });
};
