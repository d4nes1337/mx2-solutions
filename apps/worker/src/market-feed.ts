import type { Logger } from "@mx2/observability";
import type { MarketSnapshotStore } from "@mx2/db";
import { MarketWsClient, type WsMarketMessage } from "@mx2/polymarket-client";

export interface MarketFeedOptions {
  wsUrl: string;
  logger: Logger;
  marketSnapshots: MarketSnapshotStore;
  staleThresholdMs?: number;
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

const handleMessages = async (msgs: WsMarketMessage[], opts: MarketFeedOptions): Promise<void> => {
  for (const msg of msgs) {
    if (msg.event_type === "book") {
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
          receivedAt: new Date(),
        });
      } catch (e) {
        opts.logger.warn({ err: e, tokenId: msg.asset_id }, "Failed to persist WS orderbook");
      }
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
      opts.logger.info({ state }, "Market WS connection state");
    },
  });

  return {
    subscribe: (tokenIds) => client.subscribe(tokenIds),
    unsubscribe: (tokenIds) => client.unsubscribe(tokenIds),
    close: () => client.close(),
  };
};
