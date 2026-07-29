import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import type { GammaClient } from "./client.js";
import type { GammaEvent } from "./schema.js";
import type { PolymarketError } from "../errors.js";

/**
 * Recurring-series window resolution (ADR-0027 / ADR-0028).
 *
 * Shared by the API (the instant-markets feed) and the worker (rolling order
 * bindings), so both answer "which window is live right now?" the same way.
 *
 * Upstream mechanics verified live 2026-07-27:
 *  - instances are pre-created hours ahead with open books;
 *  - the instance slug ends in the unix timestamp the window OPENS
 *    ("btc-updown-5m-1785158400") — the event's own `startDate` is its
 *    CREATION time, hours earlier, and must not be used as the window start;
 *  - listing windows without `end_date_min` returns months-old never-closed
 *    instances, so that parameter is mandatory, not an optimisation.
 */

export interface SeriesWindow {
  readonly eventId: string;
  /** Instance slug, e.g. "btc-updown-5m-1785158400". */
  readonly slug: string;
  readonly title: string;
  readonly conditionId: string;
  /** CLOB token ids, index-aligned with `outcomes`. */
  readonly tokenIds: readonly string[];
  readonly outcomes: readonly string[];
  /** Gamma's indicative prices, index-aligned with `outcomes`. */
  readonly outcomePrices: readonly string[];
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly image: string;
}

const SERIES_ID_TTL_MS = 60 * 60_000;
const WINDOWS_FETCH_LIMIT = 4;
/** Slug timestamps are unix SECONDS; anything below this is not a window stamp. */
const MIN_PLAUSIBLE_WINDOW_STAMP = 1_500_000_000;

const seriesIdCache = new Map<string, { at: number; id: string; title: string }>();

/** Test hook. */
export const resetSeriesIdCache = (): void => {
  seriesIdCache.clear();
};

/** Cadence in ms inferred from the SERIES slug suffix ("…-5m", "…-hourly"). */
export const cadenceMsFromSeriesSlug = (seriesSlug: string): number => {
  if (seriesSlug.endsWith("-5m")) return 5 * 60_000;
  if (seriesSlug.endsWith("-15m")) return 15 * 60_000;
  if (seriesSlug.endsWith("-hourly") || seriesSlug.endsWith("-1h")) return 60 * 60_000;
  return 5 * 60_000;
};

/**
 * Window open time. The slug's trailing unix stamp is authoritative; the
 * cadence subtraction is only a fallback for a slug shape we don't recognise.
 */
export const windowStartMsOf = (slug: string, endMs: number, cadenceMs: number): number => {
  const tail = Number(slug.slice(slug.lastIndexOf("-") + 1));
  if (Number.isInteger(tail) && tail > MIN_PLAUSIBLE_WINDOW_STAMP && tail * 1000 < endMs)
    return tail * 1000;
  return endMs - cadenceMs;
};

export const resolveSeriesId = async (
  gamma: GammaClient,
  slug: string,
  nowMs: number = Date.now(),
): Promise<{ id: string; title: string } | null> => {
  const hit = seriesIdCache.get(slug);
  if (hit && nowMs - hit.at < SERIES_ID_TTL_MS) return { id: hit.id, title: hit.title };
  const result = await gamma.getSeries({ slug });
  if (!result.ok) return null;
  const series = result.value[0];
  if (!series || !series.id) return null;
  seriesIdCache.set(slug, { at: nowMs, id: series.id, title: series.title });
  return { id: series.id, title: series.title };
};

/** Raw live + upcoming instances for a series id, soonest-ending first. */
export const resolveSeriesWindowEvents = async (
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

const parseJsonArray = (raw: string): string[] => {
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
};

const windowFromEvent = (
  event: GammaEvent,
  cadenceMs: number,
  nowMs: number,
): SeriesWindow | null => {
  const endMs = event.endDate ? Date.parse(event.endDate) : NaN;
  if (!Number.isFinite(endMs) || endMs <= nowMs) return null; // already over
  const market = event.markets[0];
  if (!market) return null;
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const outcomes = parseJsonArray(market.outcomes);
  if (tokenIds.length === 0 || outcomes.length === 0) return null;
  return {
    eventId: event.id,
    slug: event.slug,
    title: event.title,
    conditionId: market.conditionId,
    tokenIds,
    outcomes,
    outcomePrices: parseJsonArray(market.outcomePrices),
    windowStartMs: windowStartMsOf(event.slug, endMs, cadenceMs),
    windowEndMs: endMs,
    image: market.image || event.image,
  };
};

/** Live + upcoming windows for a series slug, soonest-ending first. */
export const listSeriesWindows = async (
  gamma: GammaClient,
  seriesSlug: string,
  nowMs: number = Date.now(),
): Promise<Result<SeriesWindow[], PolymarketError>> => {
  const resolved = await resolveSeriesId(gamma, seriesSlug, nowMs);
  if (!resolved)
    return err({
      code: "UPSTREAM_ERROR",
      message: `Unknown recurring series "${seriesSlug}".`,
      statusCode: 404,
    });
  const events = await resolveSeriesWindowEvents(gamma, resolved.id, new Date(nowMs).toISOString());
  if (!events.ok) return events;
  const cadenceMs = cadenceMsFromSeriesSlug(seriesSlug);
  const windows: SeriesWindow[] = [];
  for (const event of events.value) {
    const w = windowFromEvent(event, cadenceMs, nowMs);
    if (w) windows.push(w);
  }
  return ok(windows);
};

/**
 * The single window a rolling binding targets right now. "current" is the
 * live one (already open); "next" is the following pre-created instance —
 * which lets a strategy take a position before a window even opens.
 */
export const resolveSeriesWindow = async (
  gamma: GammaClient,
  args: { seriesSlug: string; selector: "current" | "next"; nowMs?: number },
): Promise<Result<SeriesWindow | null, PolymarketError>> => {
  const nowMs = args.nowMs ?? Date.now();
  const windows = await listSeriesWindows(gamma, args.seriesSlug, nowMs);
  if (!windows.ok) return windows;
  // Windows come back soonest-ending first, so the live one (if any) is at the
  // head; anything that hasn't opened yet is "upcoming".
  const live = windows.value.find((w) => w.windowStartMs <= nowMs && w.windowEndMs > nowMs) ?? null;
  if (args.selector === "current") return ok(live ?? windows.value[0] ?? null);
  const after = live ?? windows.value[0] ?? null;
  if (!after) return ok(null);
  return ok(windows.value.find((w) => w.windowStartMs > after.windowStartMs) ?? null);
};

/** Index of the outcome a rolling binding buys, matched case-insensitively. */
export const outcomeIndexOf = (window: SeriesWindow, outcome: string): number =>
  window.outcomes.findIndex((o) => o.toLowerCase() === outcome.trim().toLowerCase());
