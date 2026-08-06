import type { FastifyInstance } from "fastify";
import type { SessionStore } from "@mx2/db";
import { makeRequireAuth } from "../middleware/require-auth.js";
import type { EventBus } from "../lib/event-bus.js";

export interface RealtimeRoutesDeps {
  sessions: SessionStore;
  eventBus: EventBus;
}

/**
 * GET /api/realtime/stream — per-wallet server-sent events.
 *
 * The signing-prompt fast path: the worker's atomic trigger commit NOTIFYs
 * Postgres on commit, the event bus fans it out here, and the browser
 * invalidates its action-center/overview queries immediately instead of
 * waiting out a poll interval. Full browser sessions only (scoped sign-link
 * sessions are rejected by requireAuth) and every event is filtered to the
 * session wallet — one user can never observe another's triggers.
 *
 * Same SSE mechanics as the shipped AI stream route (hijack + keepalive +
 * x-accel-buffering). Clients treat any failure as "no push today" and rely
 * on polling — this stream is an accelerator, never a dependency.
 */
export const registerRealtimeRoutes = (app: FastifyInstance, deps: RealtimeRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  app.get("/api/realtime/stream", { preHandler: [requireAuth] }, (req, reply) => {
    const wallet = req.user!.walletAddress;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Reconnect hint + a hello so EventSource fires `open` with data flowing.
    raw.write("retry: 3000\n\n");
    raw.write(`event: hello\ndata: {}\n\n`);

    const send = (e: Record<string, unknown>): void => {
      if (!raw.writableEnded) {
        raw.write(`event: mx2\ndata: ${JSON.stringify(e)}\n\n`);
      }
    };
    const unsubscribe = deps.eventBus.subscribe(wallet, send);
    const ping = setInterval(() => {
      if (!raw.writableEnded) raw.write(":ka\n\n");
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      if (!raw.writableEnded) raw.end();
    });
  });
};
