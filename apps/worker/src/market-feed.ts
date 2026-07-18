import type { Logger } from "@mx2/observability";
import type { MarketSnapshotStore } from "@mx2/db";
import type { BookLevel, MarketDataView } from "@mx2/rules";
import {
  MarketWsClient,
  bookSides,
  priceChangeItems,
  type Orderbook,
  type WsClientState,
  type WsMarketMessage,
} from "@mx2/polymarket-client";

/** One normalized level change for the evaluator's cached book view. */
export interface BookDelta {
  price: number;
  size: number;
  side: "bid" | "ask";
}

export interface MarketFeedOptions {
  wsUrl: string;
  logger: Logger;
  marketSnapshots: MarketSnapshotStore;
  staleThresholdMs?: number;
  /** Optional observers for the conditional-rule evaluator (single extra consumer). */
  onBookView?: (view: MarketDataView) => void;
  onReconnect?: () => void;
  onTickSizeChange?: (tokenId: string) => void;
  /**
   * Price observations for rolling price_move windows: last-trade prints,
   * price_change ticks, and book mids (which keep windows alive on quiet tape).
   */
  onPrice?: (tokenId: string, price: number, tMs: number) => void;
  /**
   * price_change level deltas — lets the evaluator patch its cached book AND
   * refresh its freshness clock between full `book` snapshots. Without this a
   * quiet-but-live market goes "stale" and hold windows keep resetting.
   */
  onBookDelta?: (tokenId: string, deltas: readonly BookDelta[], tMs: number) => void;
  /** Any-message freshness heartbeat for a token (e.g. last_trade_price). */
  onHeartbeat?: (tokenId: string, tMs: number) => void;
}

export interface MarketFeedManager {
  subscribe(tokenIds: string[]): void;
  unsubscribe(tokenIds: string[]): void;
  /** Live WS transport state — "connected" means staleness is trustworthy. */
  state(): WsClientState;
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
): MarketDataView => {
  const { bids, asks } = bookSides(msg);
  return {
    tokenId: msg.asset_id,
    conditionId: msg.market,
    bids: toLevels(bids, "bid"),
    asks: toLevels(asks, "ask"),
    marketStatus: "open",
    sourceTimeMs: receivedAtMs,
    receivedAtMs,
  };
};

/**
 * Normalize a CLOB REST orderbook into a MarketDataView — the evaluator's
 * background freshness-verify path reuses the exact same view shape the WS
 * book path produces.
 */
export const orderbookToView = (ob: Orderbook, receivedAtMs: number): MarketDataView => ({
  tokenId: ob.asset_id,
  conditionId: ob.market,
  bids: toLevels(ob.bids, "bid"),
  asks: toLevels(ob.asks, "ask"),
  marketStatus: "open",
  sourceTimeMs: receivedAtMs,
  receivedAtMs,
});

const handleMessages = async (msgs: WsMarketMessage[], opts: MarketFeedOptions): Promise<void> => {
  for (const msg of msgs) {
    if (msg.event_type === "book") {
      const receivedAtMs = Date.now();
      const { bids, asks } = bookSides(msg);
      // Feed the evaluator first (in-memory, cheap) then persist the snapshot.
      try {
        opts.onBookView?.(toView(msg, receivedAtMs));
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Rule evaluator onBookView failed");
      }
      try {
        const mid = computeMidPrice(bids, asks);
        if (mid !== null) opts.onPrice?.(msg.asset_id, Number(mid), receivedAtMs);
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Price-window mid push failed");
      }
      try {
        await opts.marketSnapshots.upsert({
          tokenId: msg.asset_id,
          conditionId: msg.market,
          bids,
          asks,
          lastTradePrice: null,
          midPrice: computeMidPrice(bids, asks),
          source: "ws",
          isStale: false,
          receivedAt: new Date(receivedAtMs),
        });
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Failed to persist WS orderbook");
      }
    } else if (msg.event_type === "tick_size_change") {
      opts.onTickSizeChange?.(msg.asset_id);
    } else if (msg.event_type === "price_change") {
      const receivedAtMs = Date.now();
      // Group per token: one onBookDelta call per asset keeps the evaluator's
      // re-evaluation count proportional to tokens, not raw level changes.
      const deltasByToken = new Map<string, BookDelta[]>();
      for (const item of priceChangeItems(msg)) {
        try {
          // Prefer the item's best bid/ask mid as the price observation —
          // level-change prices alone can be deep in the book.
          const price =
            item.bestBid !== undefined && item.bestAsk !== undefined
              ? (Number(item.bestBid) + Number(item.bestAsk)) / 2
              : Number(item.price);
          if (Number.isFinite(price)) opts.onPrice?.(item.assetId, price, receivedAtMs);
        } catch (e) {
          opts.logger.warn({ err: e, tokenId: item.assetId }, "Price-window tick push failed");
        }
        const price = Number(item.price);
        const size = item.size !== undefined ? Number(item.size) : NaN;
        const side = item.side === "BUY" ? "bid" : item.side === "SELL" ? "ask" : null;
        if (side !== null && Number.isFinite(price) && Number.isFinite(size)) {
          const list = deltasByToken.get(item.assetId) ?? [];
          list.push({ price, size, side });
          deltasByToken.set(item.assetId, list);
        } else {
          // Legacy shape without size/side carries no level info — still a
          // liveness signal for the token's cached view.
          try {
            opts.onHeartbeat?.(item.assetId, receivedAtMs);
          } catch (e) {
            opts.logger.warn({ err: e, tokenId: item.assetId }, "Heartbeat push failed");
          }
        }
      }
      for (const [tokenId, deltas] of deltasByToken) {
        try {
          opts.onBookDelta?.(tokenId, deltas, receivedAtMs);
        } catch (e) {
          opts.logger.warn({ err: e, tokenId }, "Rule evaluator onBookDelta failed");
        }
      }
    } else if (msg.event_type === "last_trade_price") {
      const receivedAtMs = Date.now();
      try {
        opts.onPrice?.(msg.asset_id, Number(msg.price), receivedAtMs);
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Price-window trade push failed");
      }
      try {
        opts.onHeartbeat?.(msg.asset_id, receivedAtMs);
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Heartbeat push failed");
      }
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
  let lastUnparsedLogMs = 0;
  const client = new MarketWsClient({
    wsUrl: opts.wsUrl,
    staleThresholdMs: opts.staleThresholdMs ?? 30_000,

    onMessage: (msgs) => {
      handleMessages(msgs, opts).catch((e: unknown) => {
        opts.logger.warn({ err: e }, "Market feed message handler error");
      });
    },

    // Schema drift upstream used to be invisible (messages silently dropped);
    // log it, throttled, so the next rename is caught in hours, not weeks.
    onUnparsed: (total, sample) => {
      const now = Date.now();
      if (now - lastUnparsedLogMs < 60_000) return;
      lastUnparsedLogMs = now;
      opts.logger.warn({ total, sample }, "Market WS messages failed schema validation");
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
    state: () => client.currentState,
    close: () => client.close(),
  };
};
