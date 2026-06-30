import type { FastifyInstance } from "fastify";
import type { GammaClient, GammaEvent, ListEventsParams } from "@mx2/polymarket-client";
import {
  buildHomeFeeds,
  DEFAULT_FEED_TUNING,
  mergeFeedTuning,
  rankFeed,
  type FeedKind,
  type FeedTuning,
} from "../feed/ranking.js";

export interface FeedRoutesDeps {
  gammaClient: GammaClient;
}

const FEED_SOURCE_PARAMS: readonly ListEventsParams[] = [
  { active: true, closed: false, order: "competitive", ascending: false },
  { active: true, closed: false, order: "volume_24hr", ascending: false },
  { active: true, closed: false, order: "liquidity", ascending: false },
  { active: true, closed: false, order: "start_date", ascending: false },
  { active: true, closed: false, order: "end_date", ascending: true },
];

export const registerFeedRoutes = (app: FastifyInstance, deps: FeedRoutesDeps): void => {
  app.get("/api/feed/home", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const tuning = tuningFromQuery(q);
    const candidateLimit = boundedInt(q["candidateLimit"], 100, 20, 250);
    const pool = await loadCandidatePool(deps.gammaClient, candidateLimit);

    if (pool.events.length === 0) {
      reply.code(502);
      return {
        error: "UPSTREAM_ERROR",
        message: "Could not load feed candidates",
        failures: pool.failures,
      };
    }

    return {
      generatedAt: new Date().toISOString(),
      degraded: pool.failures.length > 0,
      sourceCount: pool.sourceCount,
      candidateCount: pool.events.length,
      failures: pool.failures,
      tuning,
      feeds: buildHomeFeeds(pool.events, tuning),
    };
  });

  app.get("/api/feed", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const kind = parseFeedKind(q["kind"]);
    if (kind === null) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: "kind must be one of: now, top, suggestedFavorites",
      };
    }

    const tuning = tuningFromQuery(q);
    const candidateLimit = boundedInt(q["candidateLimit"], 100, 20, 250);
    const pool = await loadCandidatePool(deps.gammaClient, candidateLimit);

    if (pool.events.length === 0) {
      reply.code(502);
      return {
        error: "UPSTREAM_ERROR",
        message: "Could not load feed candidates",
        failures: pool.failures,
      };
    }

    return {
      generatedAt: new Date().toISOString(),
      degraded: pool.failures.length > 0,
      sourceCount: pool.sourceCount,
      failures: pool.failures,
      tuning,
      ...rankFeed(pool.events, kind, tuning),
    };
  });
};

const loadCandidatePool = async (gammaClient: GammaClient, limit: number) => {
  const results = await Promise.all(
    FEED_SOURCE_PARAMS.map(async (params) => ({
      params,
      result: await gammaClient.listEvents({ ...params, limit }),
    })),
  );

  const failures: string[] = [];
  const eventsById = new Map<string, GammaEvent>();

  for (const { params, result } of results) {
    if (!result.ok) {
      failures.push(`${params.order ?? "default"}:${result.error.code}`);
      continue;
    }
    for (const event of result.value) {
      if (!eventsById.has(event.id)) eventsById.set(event.id, event);
    }
  }

  return {
    events: [...eventsById.values()],
    failures,
    sourceCount: FEED_SOURCE_PARAMS.length,
  };
};

const parseFeedKind = (raw: string | undefined): FeedKind | null => {
  if (raw === "now" || raw === "top" || raw === "suggestedFavorites") return raw;
  return null;
};

const tuningFromQuery = (q: Record<string, string | undefined>): FeedTuning => {
  const partial: Partial<FeedTuning> = {};
  setNumber(partial, "limit", q["limit"], 1, 40, true);
  setNumber(partial, "minLiquidity", q["minLiquidity"], 0, 1_000_000, false);
  setNumber(partial, "minVolume24h", q["minVolume24h"], 0, 1_000_000, false);
  setNumber(partial, "newbornHours", q["newbornHours"], 0, 24, false);
  setNumber(partial, "newbornMinLiquidity", q["newbornMinLiquidity"], 0, 1_000_000, false);
  setNumber(partial, "newbornMinVolume24h", q["newbornMinVolume24h"], 0, 1_000_000, false);
  setNumber(partial, "minResolveHours", q["minResolveHours"], 0, 168, false);
  setNumber(partial, "maxResolveDays", q["maxResolveDays"], 1, 1_500, false);
  setNumber(partial, "longHorizonMaxResolveDays", q["longHorizonMaxResolveDays"], 1, 1_500, false);
  setNumber(partial, "longHorizonMinLiquidity", q["longHorizonMinLiquidity"], 0, 10_000_000, false);
  setNumber(partial, "longHorizonMinVolume1wk", q["longHorizonMinVolume1wk"], 0, 10_000_000, false);
  setNumber(partial, "minProbability", q["minProbability"], 0, 1, false);
  setNumber(partial, "maxProbability", q["maxProbability"], 0, 1, false);
  setNumber(partial, "maxSpread", q["maxSpread"], 0.001, 1, false);
  setNumber(partial, "goodSpread", q["goodSpread"], 0.001, 1, false);
  setNumber(partial, "maxPerPrimaryTag", q["maxPerPrimaryTag"], 1, 20, true);

  const tuning = mergeFeedTuning(partial);
  if (tuning.minProbability > tuning.maxProbability) {
    return {
      ...tuning,
      minProbability: DEFAULT_FEED_TUNING.minProbability,
      maxProbability: DEFAULT_FEED_TUNING.maxProbability,
    };
  }
  if (tuning.goodSpread > tuning.maxSpread) {
    return {
      ...tuning,
      goodSpread: Math.min(DEFAULT_FEED_TUNING.goodSpread, tuning.maxSpread),
    };
  }
  return tuning;
};

const setNumber = <K extends keyof FeedTuning>(
  target: Partial<FeedTuning>,
  key: K,
  raw: string | undefined,
  min: number,
  max: number,
  integer: boolean,
): void => {
  if (raw === undefined) return;
  const parsed = integer ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(parsed)) return;
  target[key] = Math.max(min, Math.min(max, parsed)) as FeedTuning[K];
};

const boundedInt = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};
