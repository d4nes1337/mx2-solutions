import pg from "pg";

/**
 * Reconnecting Postgres LISTEN client for the realtime event bus. Lives in
 * @mx2/db because this package owns the pg dependency; consumers (the API's
 * SSE fan-out) stay driver-free. The worker's atomic trigger commit NOTIFYs
 * inside its transaction (trigger-commit.ts), so payloads observed here are
 * always committed truth.
 */
export interface PgNotifyListener {
  start(): void;
  stop(): Promise<void>;
}

export interface PgNotifyListenerOptions {
  databaseUrl: string;
  channel: string;
  onPayload: (payload: string) => void;
  /** Connection lifecycle callbacks (logging). */
  onError?: (err: unknown) => void;
  onConnected?: () => void;
  /** Reconnect delay after a drop/failed connect. Default 5 s. */
  reconnectDelayMs?: number;
}

export const createPgNotifyListener = (opts: PgNotifyListenerOptions): PgNotifyListener => {
  const reconnectDelayMs = opts.reconnectDelayMs ?? 5_000;
  let client: pg.Client | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReconnect = (): void => {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelayMs);
  };

  const connect = (): void => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: opts.databaseUrl });
    client = c;
    c.on("notification", (n) => {
      if (n.payload) opts.onPayload(n.payload);
    });
    c.on("error", (err) => opts.onError?.(err));
    c.on("end", () => {
      if (stopped) return;
      client = null;
      scheduleReconnect();
    });
    c.connect()
      .then(() => c.query(`LISTEN ${opts.channel}`))
      .then(() => opts.onConnected?.())
      .catch((err: unknown) => {
        opts.onError?.(err);
        client = null;
        void c.end().catch(() => {});
        scheduleReconnect();
      });
  };

  return {
    start() {
      connect();
    },
    async stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (client) await client.end().catch(() => {});
      client = null;
    },
  };
};
