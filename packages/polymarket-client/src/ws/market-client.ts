import WebSocket from "ws";
import { WsMarketMessageSchema, type WsMarketMessage } from "./schema.js";

export type WsClientState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface MarketWsClientOptions {
  wsUrl: string;
  onMessage: (msgs: WsMarketMessage[]) => void;
  onStateChange?: (state: WsClientState) => void;
  /**
   * Called when received items fail schema validation (upstream shape drift —
   * exactly how the 2025-09 price_change change went unnoticed). `total` is the
   * cumulative unparsed count for this client; `sample` is the latest offender.
   */
  onUnparsed?: (total: number, sample: unknown) => void;
  /**
   * Transport liveness bound: with the mandated 10 s client PINGs answered by
   * PONGs, a healthy socket carries traffic at least every ~10 s. Silence
   * beyond this threshold means the transport is dead — terminate and
   * reconnect immediately instead of waiting for a TCP timeout. Default 30 s.
   */
  livenessThresholdMs?: number;
  /** Client keepalive cadence (docs: text "PING" every 10 s). */
  pingIntervalMs?: number;
  /** Base reconnect delay in ms (doubles each attempt, capped at reconnectMaxMs). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * Test seam: constructs the underlying socket. Default `new WebSocket(wsUrl)`.
   * Lets tests drive the full subscribe/reconnect/liveness ladder with an
   * in-process fake instead of a live connection.
   */
  wsFactory?: (url: string) => WebSocket;
}

/**
 * Market-channel WS client per docs.polymarket.com (verified 2026-08-06,
 * recorded in docs/INTEGRATION_VERIFIED.md §5):
 *   - initial subscription frame: `{ assets_ids: [...], type: "market" }`;
 *   - dynamic membership changes on the open socket use the OPERATION frames
 *     `{ assets_ids: [...], operation: "subscribe" | "unsubscribe" }` — the
 *     earlier code re-sent the initial-subscription shape for additions
 *     (undocumented behavior) and sent nothing at all for removals;
 *   - the CLIENT must send the text frame "PING" every 10 s (server answers
 *     "PONG"); a client that never pings gets dropped by the server — which
 *     showed up as unexplained reconnect churn.
 */
export class MarketWsClient {
  private state: WsClientState = "idle";
  private ws: WebSocket | null = null;
  private readonly subscribedIds: Set<string> = new Set();
  private livenessTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private unparsedCount = 0;

  constructor(private readonly opts: MarketWsClientOptions) {}

  get currentState(): WsClientState {
    return this.state;
  }

  subscribe(tokenIds: string[]): void {
    const added = tokenIds.filter((id) => !this.subscribedIds.has(id));
    for (const id of tokenIds) this.subscribedIds.add(id);
    if (this.state === "idle") {
      this.connect();
    } else if (this.state === "connected" && added.length > 0) {
      this.sendOperation("subscribe", added);
    }
  }

  unsubscribe(tokenIds: string[]): void {
    const removed = tokenIds.filter((id) => this.subscribedIds.has(id));
    for (const id of tokenIds) this.subscribedIds.delete(id);
    if (this.state === "connected" && removed.length > 0) {
      this.sendOperation("unsubscribe", removed);
    }
  }

  close(): void {
    this.setState("closed");
    clearTimeout(this.livenessTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    this.setState("connecting");
    const ws = this.opts.wsFactory
      ? this.opts.wsFactory(this.opts.wsUrl)
      : new WebSocket(this.opts.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.sendInitialSubscribe([...this.subscribedIds]);
      this.startPinging();
      this.resetLivenessTimer();
    });

    ws.on("message", (data) => {
      this.resetLivenessTimer();
      const text = data.toString();
      // Keepalive reply to our mandated 10s "PING" — not a data frame.
      if (text === "PONG" || text === "PING") return;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      const items = Array.isArray(json) ? json : [json];
      const messages: WsMarketMessage[] = [];
      for (const item of items) {
        const parsed = WsMarketMessageSchema.safeParse(item);
        if (parsed.success) {
          messages.push(parsed.data);
        } else {
          this.unparsedCount++;
          this.opts.onUnparsed?.(this.unparsedCount, item);
        }
      }
      if (messages.length > 0) this.opts.onMessage(messages);
    });

    ws.on("close", () => {
      if (this.state !== "closed") this.scheduleReconnect();
    });

    ws.on("error", () => {
      if (this.state !== "closed") this.scheduleReconnect();
    });
  }

  private sendInitialSubscribe(tokenIds: string[]): void {
    if (tokenIds.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ assets_ids: tokenIds, type: "market" }));
  }

  private sendOperation(operation: "subscribe" | "unsubscribe", tokenIds: string[]): void {
    if (tokenIds.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ assets_ids: tokenIds, operation }));
  }

  private startPinging(): void {
    clearInterval(this.pingTimer);
    const interval = this.opts.pingIntervalMs ?? 10_000;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
    }, interval);
  }

  private resetLivenessTimer(): void {
    clearTimeout(this.livenessTimer);
    const threshold = this.opts.livenessThresholdMs ?? 30_000;
    this.livenessTimer = setTimeout(() => {
      // Dead transport: our own PINGs guarantee ≤10s traffic on a healthy
      // socket. Kill it hard and reconnect now, not at TCP-timeout time.
      if (this.state === "connected" && this.ws) {
        this.ws.terminate();
        // `terminate` fires "close" → scheduleReconnect; the guard below
        // covers fakes/edge cases where it doesn't.
        if (this.state === "connected") this.scheduleReconnect();
      }
    }, threshold);
  }

  private scheduleReconnect(): void {
    // A close+error pair (or liveness kill + close) must not stack timers —
    // double-scheduling opened overlapping sockets.
    if (this.reconnectTimer !== undefined || (this.state as WsClientState) === "closed") return;
    clearTimeout(this.livenessTimer);
    clearInterval(this.pingTimer);
    this.ws = null;
    this.setState("reconnecting");
    const base = this.opts.reconnectBaseMs ?? 1_000;
    const max = this.opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(base * 2 ** this.reconnectAttempts, max);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.state !== "closed") this.connect();
    }, delay);
  }

  private setState(next: WsClientState): void {
    this.state = next;
    this.opts.onStateChange?.(next);
  }
}
