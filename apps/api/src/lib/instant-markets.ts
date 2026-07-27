import { ok, err, type Result } from "@mx2/core";
import type { GammaClient, GammaEvent, PolymarketError } from "@mx2/polymarket-client";
import { eventHitFromGamma, type MarketSearchHit } from "./market-search.js";

/**
 * Instant markets: the curated crypto up-or-down series (BTC 5m et al) with
 * their CURRENT live window and the next pre-created future windows — the feed
 * behind the builder's Instant Markets rail and the pinned series card.
 *
 * Upstream mechanics (verified live 2026-07-27):
 *  - each series pre-creates instances ~10h ahead with open books;
 *  - instance slugs are deterministic: `{asset}-updown-{cadence}-{unixWindowStart}`;
 *  - the canonical "current + upcoming" query is /events/pagination with
 *    series_id + closed=false + order=endDate asc + end_date_min=now —
 *    WITHOUT end_date_min Gamma returns months-old never-closed instances.
 *
 * `resolveSeriesWindows` is exported standalone (gamma injected) on purpose:
 * it is the seam Block C's worker-side rolling resolution will reuse.
 */

export interface CuratedSeries {
  slug: string;
  asset: "BTC" | "ETH" | "SOL" | "XRP" | "DOGE";
  cadence: "5m" | "15m" | "1h";
}

/**
 * Slugs verified against live /series 2026-07-27. NOTE: Gamma's own
 * `recurrence` field is unreliable (doge-up-or-down-5m reports "daily"), so
 * the cadence here is authoritative for window math and display.
 */
export const CURATED_SERIES: readonly CuratedSeries[] = [
  { slug: "btc-up-or-down-5m", asset: "BTC", cadence: "5m" },
  { slug: "eth-up-or-down-5m", asset: "ETH", cadence: "5m" },
  { slug: "sol-up-or-down-5m", asset: "SOL", cadence: "5m" },
  { slug: "xrp-up-or-down-5m", asset: "XRP", cadence: "5m" },
  { slug: "doge-up-or-down-5m", asset: "DOGE", cadence: "5m" },
  { slug: "btc-up-or-down-15m", asset: "BTC", cadence: "15m" },
  { slug: "eth-up-or-down-15m", asset: "ETH", cadence: "15m" },
  { slug: "sol-up-or-down-15m", asset: "SOL", cadence: "15m" },
  { slug: "xrp-up-or-down-15m", asset: "XRP", cadence: "15m" },
  { slug: "doge-up-or-down-15m", asset: "DOGE", cadence: "15m" },
  { slug: "btc-up-or-down-hourly", asset: "BTC", cadence: "1h" },
];

const CADENCE_MS: Record<CuratedSeries["cadence"], number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};

export interface InstantWindow {
  eventId: string;
  slug: string;
  title: string;
  /** Window OPEN time (derived — Gamma's event startDate is creation time). */
  startDate: string;
  endDate: string;
  status: "live" | "upcoming";
  market: MarketSearchHit;
}

export interface InstantSeries {
  seriesSlug: string;
  title: string;
  asset: CuratedSeries["asset"];
  cadence: CuratedSeries["cadence"];
  recurrence: string;
  windows: InstantWindow[];
}

export interface InstantMarketsResponse {
  generatedAt: string;
  /** Curated slugs that could not be resolved/fetched this refresh. */
  degraded: string[];
  series: InstantSeries[];
}

const WINDOWS_PER_SERIES = 3;
const WINDOWS_FETCH_LIMIT = 4;
const FRESH_TTL_MS = 15_000;
const STALE_TTL_MS = 2 * 60_000;
const SERIES_ID_TTL_MS = 60 * 60_000;

const seriesIdCache = new Map<string, { at: number; id: string; title: string }>();
let responseCache: { at: number; value: InstantMarketsResponse } | null = null;
let inflight: Promise<Result<InstantMarketsResponse, PolymarketError>> | null = null;

/** Test hook. */
export const resetInstantMarketsCache = (): void => {
  seriesIdCache.clear();
  responseCache = null;
  inflight = null;
};

const resolveSeriesId = async (
  gamma: GammaClient,
  slug: string,
): Promise<{ id: string; title: string } | null> => {
  const hit = seriesIdCache.get(slug);
  if (hit && Date.now() - hit.at < SERIES_ID_TTL_MS) return { id: hit.id, title: hit.title };
  const result = await gamma.getSeries({ slug });
  if (!result.ok) return null;
  const series = result.value[0];
  if (!series || !series.id) return null;
  seriesIdCache.set(slug, { at: Date.now(), id: series.id, title: series.title });
  return { id: series.id, title: series.title };
};

/**
 * Live + upcoming windows for one series, soonest-ending first. Block C seam:
 * the worker resolves a rolling SeriesRef through this exact function.
 */
export const resolveSeriesWindows = async (
  gamma: GammaClient,
  seriesId: string,
  nowIso: string,
  limit: number = WINDOWS_FETCH_LIMIT,
): Promise<Result<GammaEvent[], PolymarketError>> => {
  const result = await gamma.listEventsPaginated({
    series_id: seriesId,
    closed: false,
    end_date_min: nowIso, // mandatory — see module docblock
    order: "endDate",
    ascending: true,
    limit,
  });
  if (!result.ok) return result;
  return ok(result.value.data);
};

/** Window open time: the unix timestamp Polymarket bakes into instance slugs. */
const windowStartMs = (slug: string, endMs: number, cadenceMs: number): number => {
  const tail = Number(slug.slice(slug.lastIndexOf("-") + 1));
  if (Number.isInteger(tail) && tail > 1_500_000_000 && tail * 1000 < endMs) return tail * 1000;
  return endMs - cadenceMs;
};

const windowsFromEvents = (
  events: readonly GammaEvent[],
  curated: CuratedSeries,
  nowMs: number,
): InstantWindow[] => {
  const out: InstantWindow[] = [];
  for (const event of events) {
    if (out.length >= WINDOWS_PER_SERIES) break;
    const endMs = event.endDate ? Date.parse(event.endDate) : NaN;
    if (!Number.isFinite(endMs) || endMs <= nowMs) continue; // just-ended head
    const group = eventHitFromGamma(event);
    const head = group?.markets[0];
    if (!head) continue;
    const startMs = windowStartMs(event.slug, endMs, CADENCE_MS[curated.cadence]);
    out.push({
      eventId: event.id,
      slug: event.slug,
      title: event.title,
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
      status: startMs <= nowMs ? "live" : "upcoming",
      market: {
        ...head,
        // Curated identity is authoritative: pagination events can omit the
        // series stub, and Gamma's recurrence field is unreliable (see above).
        seriesSlug: head.seriesSlug ?? curated.slug,
        recurrence: curated.cadence,
      },
    });
  }
  return out;
};

const fetchInstantMarkets = async (
  gamma: GammaClient,
): Promise<Result<InstantMarketsResponse, PolymarketError>> => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const degraded: string[] = [];
  let firstError: PolymarketError | null = null;

  const perSeries = await Promise.all(
    CURATED_SERIES.map(async (curated): Promise<InstantSeries | null> => {
      const resolved = await resolveSeriesId(gamma, curated.slug);
      if (!resolved) {
        degraded.push(curated.slug);
        return null;
      }
      const windows = await resolveSeriesWindows(gamma, resolved.id, nowIso);
      if (!windows.ok) {
        firstError ??= windows.error;
        degraded.push(curated.slug);
        return null;
      }
      const mapped = windowsFromEvents(windows.value, curated, nowMs);
      if (mapped.length === 0) {
        degraded.push(curated.slug);
        return null;
      }
      return {
        seriesSlug: curated.slug,
        title: resolved.title || curated.slug,
        asset: curated.asset,
        cadence: curated.cadence,
        recurrence: curated.cadence,
        windows: mapped,
      };
    }),
  );

  const series = perSeries.filter((s): s is InstantSeries => s !== null);
  if (series.length === 0) {
    return err(
      firstError ?? {
        code: "UPSTREAM_ERROR",
        message: "No instant-market series could be resolved.",
        statusCode: 502,
      },
    );
  }
  return ok({ generatedAt: nowIso, degraded, series });
};

/**
 * Cached read: one shared entry (the response is identical for every client),
 * 15s fresh TTL against 5-minute windows, single-inflight, stale-on-error for
 * 2 minutes.
 */
export const getInstantMarkets = async (
  gamma: GammaClient,
): Promise<Result<InstantMarketsResponse, PolymarketError>> => {
  const now = Date.now();
  if (responseCache && now - responseCache.at < FRESH_TTL_MS) return ok(responseCache.value);

  if (!inflight) {
    inflight = fetchInstantMarkets(gamma)
      .then((result) => {
        if (result.ok) responseCache = { at: Date.now(), value: result.value };
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const result = await inflight;
  if (result.ok) return result;
  if (responseCache && now - responseCache.at < STALE_TTL_MS) return ok(responseCache.value);
  return result;
};
