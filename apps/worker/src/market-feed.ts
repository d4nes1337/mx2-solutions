import type { Logger } from "@mx2/observability";
import type { MarketSnapshotStore } from "@mx2/db";
import type { BookLevel, MarketDataView } from "@mx2/rules";
import { MarketWsClient, type WsClientState, type WsMarketMessage } from "@mx2/polymarket-client";

export interface MarketFeedOptions {
  wsUrl: string;
  logger: Logger;
  marketSnapshots: MarketSnapshotStore;
  staleThresholdMs?: number;
  /** Optional observers for the conditional-rule evaluator (single extra consumer). */
  onBookView?: (view: MarketDataView) => void;
  onReconnect?: () => void;
  onTickSizeChange?: (tokenId: string) => void;
}

export interface MarketFeedManager {
  subscribe(tokenIds: string[]): void;
  unsubscribe(tokenIds: string[]): void;
  close(): void;
}

const computeMidPrice = (
  bids: readonly { price: string }[],
  asks: readonly { price: string }[],
): string | null => {
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined) return null;
  const mid = (Number(bestBid) + Number(bestAsk)) / 2;
  return mid.toFixed(4);
};

/** Map raw level strings → numeric levels, sorted best-first and dropping junk. */
const toLevels = (
  raw: readonly { price: string; size: string }[],
  side: "bid" | "ask",
): BookLevel[] =>
  raw
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));

/**
 * Normalize a WS `book` message into a MarketDataView. The live source/receive
 * clocks are both set to the local receive time so staleness is measured on a
 * single clock (upstream clock-skew handling is a deferred failure mode —
 * docs/04 §7); replay fixtures may use true upstream times.
 */
const toView = (
  msg: Extract<WsMarketMessage, { event_type: "book" }>,
  receivedAtMs: number,
): MarketDataView => ({
  tokenId: msg.asset_id,
  conditionId: msg.market,
  bids: toLevels(msg.buys, "bid"),
  asks: toLevels(msg.sells, "ask"),
  marketStatus: "open",
  sourceTimeMs: receivedAtMs,
  receivedAtMs,
});

const handleMessages = async (msgs: WsMarketMessage[], opts: MarketFeedOptions): Promise<void> => {
  for (const msg of msgs) {
    if (msg.event_type === "book") {
      const receivedAtMs = Date.now();
      // Feed the evaluator first (in-memory, cheap) then persist the snapshot.
      try {
        opts.onBookView?.(toView(msg, receivedAtMs));
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Rule evaluator onBookView failed");
      }
      try {
        await opts.marketSnapshots.upsert({
          tokenId: msg.asset_id,
          conditionId: msg.market,
          bids: msg.buys,
          asks: msg.sells,
          lastTradePrice: null,
          midPrice: computeMidPrice(msg.buys, msg.sells),
          source: "ws",
          isStale: false,
          receivedAt: new Date(receivedAtMs),
        });
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Failed to persist WS orderbook");
      }
    } else if (msg.event_type === "tick_size_change") {
      opts.onTickSizeChange?.(msg.asset_id);
    } else if (msg.event_type === "last_trade_price") {
      try {
        const existing = await opts.marketSnapshots.findByTokenId(msg.asset_id);
        if (existing !== null) {
          await opts.marketSnapshots.upsert({
            tokenId: existing.tokenId,
            conditionId: existing.conditionId,
            bids: existing.bids as readonly unknown[],
            asks: existing.asks as readonly unknown[],
            lastTradePrice: msg.price,
            midPrice: existing.midPrice,
            source: existing.source,
            isStale: existing.isStale,
            receivedAt: new Date(),
          });
        }
      } catch (e) {
        opts.logger.warn({ err: e }, "Failed to update last trade price");
      }
    }
  }
};

export const createMarketFeedManager = (opts: MarketFeedOptions): MarketFeedManager => {
  let lastState: WsClientState = "idle";
  const client = new MarketWsClient({
    wsUrl: opts.wsUrl,
    staleThresholdMs: opts.staleThresholdMs ?? 30_000,

    onMessage: (msgs) => {
      handleMessages(msgs, opts).catch((e: unknown) => {
        opts.logger.warn({ err: e }, "Market feed message handler error");
      });
    },

    onStale: (tokenIds) => {
      for (const tokenId of tokenIds) {
        opts.logger.warn({ tokenId }, "Market WS data stale — marking snapshot");
        opts.marketSnapshots.markStale(tokenId).catch((e: unknown) => {
          opts.logger.warn({ err: e, tokenId }, "Failed to mark snapshot as stale");
        });
      }
    },

    onStateChange: (state) => {
      // A drop to "reconnecting" means continuity may be broken — the evaluator
      // resets any accumulating windows (fail-closed, docs/04 §3.3).
      if (state === "reconnecting" && lastState !== "reconnecting") {
        try {
          opts.onReconnect?.();
        } catch (e) {
          opts.logger.warn({ err: e }, "Rule evaluator onReconnect failed");
        }
      }
      lastState = state;
      opts.logger.info({ state }, "Market WS connection state");
    },
  });

  return {
    subscribe: (tokenIds) => client.subscribe(tokenIds),
    unsubscribe: (tokenIds) => client.unsubscribe(tokenIds),
    close: () => client.close(),
  };
};
