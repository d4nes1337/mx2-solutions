import type { FastifyInstance } from "fastify";
import type { GammaClient, ListEventsParams } from "@mx2/polymarket-client";
import { groupedEvent } from "../lib/event-siblings.js";

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
    if (q["order"] !== undefined) evtParams.order = q["order"];
    if (q["ascending"] === "true") evtParams.ascending = true;
    else if (q["ascending"] === "false") evtParams.ascending = false;
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

  // ── GET /api/events/:id/markets — event with ordered sub-markets ──────────
  // Same grouped DTO as /api/markets/search/grouped: powers the event page and
  // the market-detail "More from this event" panel. 30s cache.
  app.get("/api/events/:id/markets", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await groupedEvent(deps.gammaClient, id);
    if (!result.ok) {
      reply.code(result.error.statusCode === 404 ? 404 : 502);
      return { error: result.error.code, message: result.error.message };
    }
    if (!result.value) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Event not found or has no markets." };
    }
    return result.value;
  });
};
