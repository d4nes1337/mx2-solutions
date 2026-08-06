/**
 * MarketWsClient transport tests, driven through the wsFactory seam — the
 * subscribe/keepalive/reconnect ladder had ZERO coverage before (the old
 * suite refused to call subscribe to avoid opening a real socket).
 *
 * Contract under test (docs.polymarket.com, verified 2026-08-06):
 *   - initial frame `{assets_ids, type:"market"}` on open;
 *   - dynamic membership via `{assets_ids, operation:"subscribe"|"unsubscribe"}`;
 *   - client sends text "PING" every 10 s;
 *   - silence beyond the liveness threshold terminates + reconnects, once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { MarketWsClient, type WsClientState } from "./ws/market-client.js";

class FakeWs extends EventEmitter {
  static instances: FakeWs[] = [];
  sent: string[] = [];
  readyState = 0; // CONNECTING
  terminated = false;
  closed = false;
  constructor() {
    super();
    FakeWs.instances.push(this);
  }
  open(): void {
    this.readyState = 1; // OPEN
    this.emit("open");
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
}

const makeClient = (over: { onMessage?: (m: unknown[]) => void } = {}) => {
  const states: WsClientState[] = [];
  const messages: unknown[][] = [];
  const unparsed: unknown[] = [];
  const client = new MarketWsClient({
    wsUrl: "wss://fake.test/ws/market",
    onMessage: over.onMessage ?? ((m) => messages.push(m)),
    onStateChange: (s) => states.push(s),
    onUnparsed: (_t, sample) => unparsed.push(sample),
    wsFactory: () => new FakeWs() as unknown as WebSocket,
  });
  return { client, states, messages, unparsed };
};

const lastWs = (): FakeWs => FakeWs.instances[FakeWs.instances.length - 1]!;

describe("MarketWsClient transport contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the initial type:market frame on open, then operation frames for membership changes", () => {
    const { client } = makeClient();
    client.subscribe(["tok-a", "tok-b"]);
    const ws = lastWs();
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ assets_ids: ["tok-a", "tok-b"], type: "market" });

    client.subscribe(["tok-c", "tok-a"]); // tok-a already subscribed → delta is only tok-c
    expect(JSON.parse(ws.sent[1]!)).toEqual({ assets_ids: ["tok-c"], operation: "subscribe" });

    client.unsubscribe(["tok-b", "tok-x"]); // tok-x never subscribed → only tok-b
    expect(JSON.parse(ws.sent[2]!)).toEqual({ assets_ids: ["tok-b"], operation: "unsubscribe" });
    client.close();
  });

  it("sends the text PING keepalive every 10s while connected", () => {
    const { client } = makeClient();
    client.subscribe(["tok-a"]);
    const ws = lastWs();
    ws.open();
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(10_000);
    expect(ws.sent.filter((f) => f === "PING")).toHaveLength(2);
    client.close();
    vi.advanceTimersByTime(30_000);
    expect(ws.sent.filter((f) => f === "PING")).toHaveLength(2); // stopped after close
  });

  it("ignores PONG frames (no onMessage, no unparsed noise)", () => {
    const { client, messages, unparsed } = makeClient();
    client.subscribe(["tok-a"]);
    const ws = lastWs();
    ws.open();
    ws.emit("message", Buffer.from("PONG"));
    expect(messages).toHaveLength(0);
    expect(unparsed).toHaveLength(0);
    client.close();
  });

  it("terminates a silent socket at the liveness threshold and reconnects with the full set", () => {
    const { client, states } = makeClient();
    client.subscribe(["tok-a", "tok-b"]);
    const ws1 = lastWs();
    ws1.open();
    // Traffic keeps it alive…
    vi.advanceTimersByTime(20_000);
    ws1.emit("message", Buffer.from("PONG"));
    expect(ws1.terminated).toBe(false);
    // …then 30s of total silence kills it.
    vi.advanceTimersByTime(30_001);
    expect(ws1.terminated).toBe(true);
    expect(states).toContain("reconnecting");

    // Backoff elapses → a NEW socket; on open it re-sends the FULL set.
    vi.advanceTimersByTime(1_000);
    const ws2 = lastWs();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    expect(JSON.parse(ws2.sent[0]!)).toEqual({ assets_ids: ["tok-a", "tok-b"], type: "market" });
    client.close();
  });

  it("a close+error storm schedules exactly ONE reconnect (no overlapping sockets)", () => {
    const { client } = makeClient();
    client.subscribe(["tok-a"]);
    const ws1 = lastWs();
    ws1.open();
    ws1.emit("error", new Error("boom"));
    ws1.emit("close");
    ws1.emit("error", new Error("boom again"));
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000); // first backoff step
    expect(FakeWs.instances).toHaveLength(2);
    vi.advanceTimersByTime(60_000); // nothing else pending
    expect(FakeWs.instances).toHaveLength(2);
    client.close();
  });

  it("close() is terminal: no reconnect after an explicit close", () => {
    const { client } = makeClient();
    client.subscribe(["tok-a"]);
    const ws = lastWs();
    ws.open();
    client.close();
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.instances).toHaveLength(1);
    expect(client.currentState).toBe("closed");
  });
});
