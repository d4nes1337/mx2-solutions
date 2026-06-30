import type { GammaEvent, GammaMarket } from "@mx2/polymarket-client";

export type FeedKind = "now" | "top" | "suggestedFavorites";

export type FeedReason =
  | "active"
  | "balanced"
  | "competitive"
  | "featured"
  | "fresh"
  | "liquid"
  | "soon"
  | "tight"
  | "volume";

export interface FeedTuning {
  limit: number;
  minLiquidity: number;
  minVolume24h: number;
  newbornHours: number;
  newbornMinLiquidity: number;
  newbornMinVolume24h: number;
  minResolveHours: number;
  maxResolveDays: number;
  longHorizonMaxResolveDays: number;
  longHorizonMinLiquidity: number;
  longHorizonMinVolume1wk: number;
  minProbability: number;
  maxProbability: number;
  maxSpread: number;
  goodSpread: number;
  maxPerPrimaryTag: number;
}

export interface FeedMetricSnapshot {
  mid: number;
  spread: number;
  liquidity: number;
  volume24h: number;
  volume1wk: number;
  ageHours: number;
  resolveHours: number;
  competitive: number;
  featured: boolean;
  primaryTag: string | null;
  endDate: string | null;
}

export interface FeedMeta {
  kind: FeedKind;
  score: number;
  selectedMarketId: string;
  reasons: FeedReason[];
  metrics: FeedMetricSnapshot;
}

export type RankedGammaEvent = GammaEvent & { _feed: FeedMeta };

export interface RankedFeed {
  kind: FeedKind;
  events: RankedGammaEvent[];
  count: number;
  candidateCount: number;
  rejectedCount: number;
}

export interface HomeFeeds {
  now: RankedFeed;
  top: RankedFeed;
  suggestedFavorites: RankedFeed;
}

interface ScoredMarket {
  event: GammaEvent;
  market: GammaMarket;
  score: number;
  reasons: FeedReason[];
  metrics: FeedMetricSnapshot;
}

export const DEFAULT_FEED_TUNING: FeedTuning = {
  limit: 20,
  minLiquidity: 2_000,
  minVolume24h: 1_000,
  newbornHours: 0.5,
  newbornMinLiquidity: 10_000,
  newbornMinVolume24h: 2_000,
  minResolveHours: 2,
  maxResolveDays: 365,
  longHorizonMaxResolveDays: 920,
  longHorizonMinLiquidity: 500_000,
  longHorizonMinVolume1wk: 250_000,
  minProbability: 0.03,
  maxProbability: 0.97,
  maxSpread: 0.1,
  goodSpread: 0.03,
  maxPerPrimaryTag: 6,
};

export const mergeFeedTuning = (partial: Partial<FeedTuning> = {}): FeedTuning => ({
  ...DEFAULT_FEED_TUNING,
  ...partial,
});

export const buildHomeFeeds = (
  events: readonly GammaEvent[],
  tuning: FeedTuning = DEFAULT_FEED_TUNING,
  nowMs = Date.now(),
): HomeFeeds => {
  const now = rankFeed(events, "now", tuning, nowMs);
  const nowIds = new Set(now.events.map((e) => e.id));

  const top = rankFeed(events, "top", tuning, nowMs, nowIds);
  const topIds = new Set(top.events.map((e) => e.id));
  const screenIds = new Set([...nowIds, ...topIds]);

  let suggestedFavorites = rankFeed(events, "suggestedFavorites", tuning, nowMs, screenIds);
  if (suggestedFavorites.events.length < Math.min(6, tuning.limit)) {
    suggestedFavorites = rankFeed(events, "suggestedFavorites", tuning, nowMs, new Set());
  }

  return { now, top, suggestedFavorites };
};

export const rankFeed = (
  events: readonly GammaEvent[],
  kind: FeedKind,
  tuning: FeedTuning = DEFAULT_FEED_TUNING,
  nowMs = Date.now(),
  excludedEventIds: ReadonlySet<string> = new Set(),
): RankedFeed => {
  const candidates: ScoredMarket[] = [];
  let rejectedCount = 0;

  for (const event of events) {
    if (excludedEventIds.has(event.id)) continue;
    const best = bestMarketForEvent(event, kind, tuning, nowMs);
    if (best === null) {
      rejectedCount += 1;
      continue;
    }
    candidates.push(best);
  }

  const tagCounts = new Map<string, number>();
  const selected: RankedGammaEvent[] = [];

  for (const candidate of candidates.sort(compareScoredMarkets)) {
    const tag = candidate.metrics.primaryTag ?? "other";
    const nextTagCount = (tagCounts.get(tag) ?? 0) + 1;
    if (nextTagCount > tuning.maxPerPrimaryTag) continue;

    tagCounts.set(tag, nextTagCount);
    selected.push(toRankedEvent(candidate, kind));
    if (selected.length >= tuning.limit) break;
  }

  return {
    kind,
    events: selected,
    count: selected.length,
    candidateCount: candidates.length,
    rejectedCount,
  };
};

const bestMarketForEvent = (
  event: GammaEvent,
  kind: FeedKind,
  tuning: FeedTuning,
  nowMs: number,
): ScoredMarket | null => {
  if (!event.active || event.closed || boolField(event, "archived")) {
    return null;
  }

  let best: ScoredMarket | null = null;
  for (const market of event.markets) {
    const scored = scoreMarket(event, market, kind, tuning, nowMs);
    if (scored === null) continue;
    if (best === null || scored.score > best.score) best = scored;
  }
  return best;
};

const scoreMarket = (
  event: GammaEvent,
  market: GammaMarket,
  kind: FeedKind,
  tuning: FeedTuning,
  nowMs: number,
): ScoredMarket | null => {
  if (
    !market.active ||
    market.closed ||
    boolField(market, "archived") ||
    market.acceptingOrders === false
  ) {
    return null;
  }

  if (parseJsonArray(market.clobTokenIds).length === 0) return null;

  const bid = numField(market, ["bestBid"]);
  const ask = numField(market, ["bestAsk"]);
  if (bid <= 0 || ask <= 0 || ask < bid) return null;

  const mid = (bid + ask) / 2;
  if (mid < tuning.minProbability || mid > tuning.maxProbability) return null;

  const spread = numField(market, ["spread"]) || ask - bid;
  if (spread <= 0 || spread > tuning.maxSpread) return null;

  const endDate = stringField(market, ["endDate"]) ?? stringField(event, ["endDate"]);
  const endMs = parseDateMs(endDate);
  if (!Number.isFinite(endMs)) return null;
  const resolveHours = (endMs - nowMs) / 3_600_000;
  if (resolveHours < tuning.minResolveHours) return null;

  const liquidity = Math.max(
    numField(market, ["liquidityClob", "liquidityNum", "liquidity"]),
    numField(event, ["liquidityClob", "liquidityNum", "liquidity"]),
  );
  const volume24h = Math.max(
    numField(market, ["volume24hrClob", "volume24hr", "volume24h"]),
    numField(event, ["volume24hrClob", "volume24hr", "volume24h"]),
  );
  const volume1wk = Math.max(
    numField(market, ["volume1wkClob", "volume1wk", "volume7d", "volume"]),
    numField(event, ["volume1wkClob", "volume1wk", "volume7d", "volume"]),
  );

  if (liquidity < tuning.minLiquidity && volume24h < tuning.minVolume24h) return null;

  const ageHours = ageHoursFor(event, market, nowMs);
  if (
    ageHours < tuning.newbornHours &&
    liquidity < tuning.newbornMinLiquidity &&
    volume24h < tuning.newbornMinVolume24h
  ) {
    return null;
  }

  const resolveDays = resolveHours / 24;
  const longHorizonAllowed =
    kind !== "now" &&
    resolveDays <= tuning.longHorizonMaxResolveDays &&
    (liquidity >= tuning.longHorizonMinLiquidity || volume1wk >= tuning.longHorizonMinVolume1wk);
  if (resolveDays > tuning.maxResolveDays && !longHorizonAllowed) return null;

  const featured = boolField(event, "featured") || boolField(market, "featured");
  const competitive = clamp01(
    Math.max(numField(event, ["competitive"]), numField(market, ["competitive"])),
  );
  const tag = primaryTag(event, market);
  const metrics: FeedMetricSnapshot = {
    mid,
    spread,
    liquidity,
    volume24h,
    volume1wk,
    ageHours,
    resolveHours,
    competitive,
    featured,
    primaryTag: tag,
    endDate,
  };

  return {
    event,
    market,
    score: scoreByKind(kind, metrics, tuning),
    reasons: reasonCodes(metrics, tuning),
    metrics,
  };
};

const scoreByKind = (kind: FeedKind, m: FeedMetricSnapshot, tuning: FeedTuning): number => {
  const activity24 = logScore(m.volume24h, 25_000);
  const activity7 = logScore(m.volume1wk, 150_000);
  const liquidity = logScore(m.liquidity, 75_000);
  const urgency = urgencyScore(m.resolveHours);
  const newness = newnessScore(m.ageHours, m.volume24h, m.liquidity);
  const spread = spreadScore(m.spread, tuning);
  const probability = probabilityInterest(m.mid);
  const polymarketSignal = clamp01(
    m.competitive * 0.7 + (m.featured ? 0.2 : 0) + (m.liquidity >= 10_000 ? 0.1 : 0),
  );
  const tradability = liquidity * 0.5 + spread * 0.3 + probability * 0.2;

  if (kind === "now") {
    return (
      activity24 * 0.3 +
      urgency * 0.24 +
      newness * 0.14 +
      tradability * 0.22 +
      polymarketSignal * 0.1
    );
  }

  if (kind === "suggestedFavorites") {
    return (
      activity7 * 0.28 +
      activity24 * 0.22 +
      liquidity * 0.18 +
      probability * 0.12 +
      urgency * 0.1 +
      polymarketSignal * 0.1
    );
  }

  return (
    activity7 * 0.34 +
    liquidity * 0.24 +
    activity24 * 0.18 +
    probability * 0.12 +
    polymarketSignal * 0.12
  );
};

const reasonCodes = (m: FeedMetricSnapshot, tuning: FeedTuning): FeedReason[] => {
  const reasons: FeedReason[] = [];
  if (m.volume24h >= tuning.minVolume24h * 5 || m.volume1wk >= 50_000) reasons.push("volume");
  if (m.liquidity >= 10_000) reasons.push("liquid");
  if (m.resolveHours <= 7 * 24) reasons.push("soon");
  if (m.ageHours <= 24 && (m.volume24h >= tuning.minVolume24h || m.liquidity >= 10_000)) {
    reasons.push("fresh");
  }
  if (m.spread <= tuning.goodSpread) reasons.push("tight");
  if (m.mid >= 0.15 && m.mid <= 0.85) reasons.push("balanced");
  if (m.competitive >= 0.8) reasons.push("competitive");
  if (m.featured) reasons.push("featured");
  if (reasons.length === 0) reasons.push("active");
  return reasons.slice(0, 4);
};

const toRankedEvent = (candidate: ScoredMarket, kind: FeedKind): RankedGammaEvent => {
  const selected = candidate.market;
  const rest = candidate.event.markets.filter((market) => market.id !== selected.id);
  return {
    ...candidate.event,
    markets: [selected, ...rest],
    _feed: {
      kind,
      score: round(candidate.score, 6),
      selectedMarketId: selected.id,
      reasons: candidate.reasons,
      metrics: {
        ...candidate.metrics,
        mid: round(candidate.metrics.mid, 6),
        spread: round(candidate.metrics.spread, 6),
        liquidity: round(candidate.metrics.liquidity, 2),
        volume24h: round(candidate.metrics.volume24h, 2),
        volume1wk: round(candidate.metrics.volume1wk, 2),
        ageHours: round(candidate.metrics.ageHours, 2),
        resolveHours: round(candidate.metrics.resolveHours, 2),
        competitive: round(candidate.metrics.competitive, 6),
      },
    },
  };
};

const compareScoredMarkets = (a: ScoredMarket, b: ScoredMarket): number =>
  b.score - a.score ||
  b.metrics.volume24h - a.metrics.volume24h ||
  b.metrics.liquidity - a.metrics.liquidity ||
  a.metrics.resolveHours - b.metrics.resolveHours ||
  a.event.id.localeCompare(b.event.id);

const urgencyScore = (resolveHours: number): number => {
  if (resolveHours < 2) return 0;
  if (resolveHours <= 24) return 1;
  const days = resolveHours / 24;
  if (days <= 7) return 0.85;
  if (days <= 30) return 0.55;
  if (days <= 90) return 0.28;
  if (days <= 365) return 0.12;
  return 0.03;
};

const newnessScore = (ageHours: number, volume24h: number, liquidity: number): number => {
  const traction = Math.max(logScore(volume24h, 5_000), logScore(liquidity, 20_000));
  if (ageHours <= 1) return traction * 0.9;
  if (ageHours <= 24) return 0.75 * traction;
  if (ageHours <= 72) return 0.45 * traction;
  if (ageHours <= 7 * 24) return 0.2 * traction;
  return 0;
};

const spreadScore = (spread: number, tuning: FeedTuning): number => {
  if (spread <= tuning.goodSpread) return 1;
  return clamp01(1 - (spread - tuning.goodSpread) / (tuning.maxSpread - tuning.goodSpread));
};

const probabilityInterest = (mid: number): number => {
  const distance = Math.abs(mid - 0.5);
  if (distance <= 0.3) return 1;
  return clamp01(1 - (distance - 0.3) / 0.2);
};

const logScore = (value: number, target: number): number => {
  if (value <= 0 || target <= 0) return 0;
  return clamp01(Math.log10(1 + value) / Math.log10(1 + target));
};

const ageHoursFor = (event: GammaEvent, market: GammaMarket, nowMs: number): number => {
  const createdMs = parseDateMs(
    stringField(market, ["createdAt", "creationDate", "startDate"]) ??
      stringField(event, ["createdAt", "creationDate", "startDate"]),
  );
  if (!Number.isFinite(createdMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - createdMs) / 3_600_000);
};

const primaryTag = (event: GammaEvent, market: GammaMarket): string | null => {
  const eventTag = event.tags
    .map((tag) => tag.slug ?? tag.label ?? null)
    .find((tag): tag is string => typeof tag === "string" && tag.length > 0);
  if (eventTag) return eventTag;
  const category = stringField(market, ["category"]);
  return category && category.length > 0 ? category : null;
};

const parseJsonArray = (raw: string | undefined | null): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const numField = (obj: GammaEvent | GammaMarket, keys: string[]): number => {
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(num)) return num;
  }
  return 0;
};

const stringField = (obj: GammaEvent | GammaMarket, keys: string[]): string | null => {
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

const boolField = (obj: GammaEvent | GammaMarket, key: string): boolean => {
  const value = (obj as Record<string, unknown>)[key];
  return value === true;
};

const parseDateMs = (raw: string | null | undefined): number => {
  if (!raw) return Number.NaN;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Number.NaN;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
