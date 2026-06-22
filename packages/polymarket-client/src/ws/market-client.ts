import WebSocket from "ws";
import { WsMarketMessageSchema, type WsMarketMessage } from "./schema.js";

export type WsClientState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface MarketWsClientOptions {
  wsUrl: string;
  onMessage: (msgs: WsMarketMessage[]) => void;
  onStateChange?: (state: WsClientState) => void;
  onStale?: (tokenIds: string[]) => void;
  /** How long without any message before marking the channel as stale. Default 30 s. */
  staleThresholdMs?: number;
  /** Base reconnect delay in ms (doubles each attempt, capped at reconnectMaxMs). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class MarketWsClient {
  private state: WsClientState = "idle";
  private ws: WebSocket | null = null;
  private readonly subscribedIds: Set<string> = new Set();
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;

  constructor(private readonly opts: MarketWsClientOptions) {}

  get currentState(): WsClientState {
    return this.state;
  }

  subscribe(tokenIds: string[]): void {
    for (const id of tokenIds) this.subscribedIds.add(id);
    if (this.state === "idle") {
      this.connect();
    } else if (this.state === "connected") {
      this.sendSubscribe(tokenIds);
    }
  }

  unsubscribe(tokenIds: string[]): void {
    for (const id of tokenIds) this.subscribedIds.delete(id);
  }

  close(): void {
    this.setState("closed");
    clearTimeout(this.staleTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    this.setState("connecting");
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.sendSubscribe([...this.subscribedIds]);
      this.resetStaleTimer();
    });

    ws.on("message", (data) => {
      this.resetStaleTimer();
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      const items = Array.isArray(json) ? json : [json];
      const messages: WsMarketMessage[] = [];
      for (const item of items) {
        const parsed = WsMarketMessageSchema.safeParse(item);
        if (parsed.success) messages.push(parsed.data);
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

  private sendSubscribe(tokenIds: string[]): void {
    if (tokenIds.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ assets_ids: tokenIds, type: "market" }));
  }

  private resetStaleTimer(): void {
    clearTimeout(this.staleTimer);
    const threshold = this.opts.staleThresholdMs ?? 30_000;
    this.staleTimer = setTimeout(() => {
      this.opts.onStale?.([...this.subscribedIds]);
    }, threshold);
  }

  private scheduleReconnect(): void {
    clearTimeout(this.staleTimer);
    this.ws = null;
    this.setState("reconnecting");
    const base = this.opts.reconnectBaseMs ?? 1_000;
    const max = this.opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(base * 2 ** this.reconnectAttempts, max);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (this.state !== "closed") this.connect();
    }, delay);
  }

  private setState(next: WsClientState): void {
    this.state = next;
    this.opts.onStateChange?.(next);
  }
}
