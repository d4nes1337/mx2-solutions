import type { Logger } from "@mx2/observability";
import { createPgNotifyListener, EVENT_BUS_CHANNEL, type PgNotifyListener } from "@mx2/db";

/**
 * Realtime event bus: Postgres LISTEN/NOTIFY fan-out to in-process
 * subscribers (the SSE route). The worker's atomic trigger commit pg_notifies
 * on the same channel INSIDE its transaction, so a listener can never observe
 * a trigger that was rolled back — and a signing prompt reaches the browser
 * in commit→NOTIFY→SSE→refetch time (≈100–500 ms) instead of the 4–9 s
 * worst-case of pure polling. Polling stays untouched as the fallback: if
 * this bus is down, the product degrades to exactly its pre-SSE behavior.
 */
export interface RealtimeEvent {
  kind: string;
  walletAddress?: string;
  [key: string]: unknown;
}

export interface EventBus {
  /** Subscribe to events for one wallet (case-insensitive). Returns unsubscribe. */
  subscribe(walletAddress: string, fn: (e: RealtimeEvent) => void): () => void;
  /** In-process publish — API-side mutations and tests. */
  publish(e: RealtimeEvent): void;
  start(): void;
  stop(): Promise<void>;
}

export interface PgEventBusOptions {
  databaseUrl: string;
  logger: Logger;
  /** Reconnect delay after the LISTEN connection drops. Default 5 s. */
  reconnectDelayMs?: number;
}

const createFanout = (logger: Logger) => {
  const subscribers = new Map<string, Set<(e: RealtimeEvent) => void>>();
  return {
    subscribe(walletAddress: string, fn: (e: RealtimeEvent) => void): () => void {
      const wallet = walletAddress.toLowerCase();
      let subs = subscribers.get(wallet);
      if (!subs) {
        subs = new Set();
        subscribers.set(wallet, subs);
      }
      subs.add(fn);
      return () => {
        const set = subscribers.get(wallet);
        if (!set) return;
        set.delete(fn);
        if (set.size === 0) subscribers.delete(wallet);
      };
    },
    publish(e: RealtimeEvent): void {
      const wallet = typeof e.walletAddress === "string" ? e.walletAddress.toLowerCase() : null;
      if (wallet === null) return;
      const subs = subscribers.get(wallet);
      if (!subs) return;
      for (const fn of [...subs]) {
        try {
          fn(e);
        } catch (err) {
          logger.warn({ err }, "Realtime subscriber threw");
        }
      }
    },
  };
};

export const createPgEventBus = (opts: PgEventBusOptions): EventBus => {
  const { logger } = opts;
  const fanout = createFanout(logger);
  const listener: PgNotifyListener = createPgNotifyListener({
    databaseUrl: opts.databaseUrl,
    channel: EVENT_BUS_CHANNEL,
    ...(opts.reconnectDelayMs !== undefined ? { reconnectDelayMs: opts.reconnectDelayMs } : {}),
    onPayload: (payload) => {
      try {
        fanout.publish(JSON.parse(payload) as RealtimeEvent);
      } catch (err) {
        logger.warn({ err }, "Unparseable event-bus payload");
      }
    },
    onError: (err) => logger.warn({ err }, "Event-bus LISTEN connection error — will retry"),
    onConnected: () => logger.info("Event-bus LISTEN established"),
  });

  return {
    subscribe: fanout.subscribe,
    publish: fanout.publish,
    start: () => listener.start(),
    stop: () => listener.stop(),
  };
};

/** In-process-only bus for tests and buildApp defaults (no LISTEN). */
export const createInProcessEventBus = (logger: Logger): EventBus => {
  const fanout = createFanout(logger);
  return {
    subscribe: fanout.subscribe,
    publish: fanout.publish,
    start: () => {},
    stop: async () => {},
  };
};
