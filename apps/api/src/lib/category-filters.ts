import { ok, err, type Result } from "@mx2/core";
import type { GammaClient, PolymarketError } from "@mx2/polymarket-client";

/**
 * Category sub-filters: the second chip row polymarket.com renders under a
 * category (Politics → Trump / Midterms / Congress…, Geopolitics → Iran /
 * Ukraine / Israel…).
 *
 * Upstream mechanics (verified live 2026-07-29):
 *  - the row is Gamma /tags/slug/{slug}/related-tags, ordered by `rank` —
 *    reproducing polymarket.com's row exactly for politics and geopolitics;
 *  - that endpoint returns relationships only (`relatedTagID`), so each id
 *    costs a /tags/{id} lookup to get a label and slug — Gamma has no bulk
 *    tag-by-id form (`?id=` is ignored and returns unrelated tags);
 *  - each chip's count is /events/pagination?tag_slug=… totalResults, and a
 *    sub-filter is a plain tag_slug filter — `trump` returns 274, exactly the
 *    count polymarket.com prints on its Trump chip;
 *  - polymarket.com HIDES zero-count sub-tags: geopolitics ranks 17 tags but
 *    renders 16 (thailand-cambodia is 0), politics ranks 24 but renders 23
 *    (colombia-election is 0). We do the same;
 *  - some categories have no curated sub-tags at all (elections, esports, art)
 *    and legitimately return [] — an empty row, not an error.
 *
 * DELIBERATE DIVERGENCE — the "All" count. polymarket.com prints the SUM of the
 * sub-filter counts there (geopolitics: 559 = 106+19+37+…; politics: "2.2K" =
 * 2221), which double-counts events carrying two sub-tags and does not match
 * the category tag's own event count (380 and 1549 respectively). We report the
 * category tag count, because that is what our "All" chip actually loads into
 * the grid — a chip whose count contradicts its own result set is worse than
 * one that differs from theirs.
 *
 * Cost is 1 + 2N upstream calls per category, so this is cached hard and built
 * lazily — only for a category the user actually opens.
 */

export interface CategoryFilter {
  label: string;
  slug: string;
  /** Live open-event count behind this sub-tag; always > 0 (empties are cut). */
  count: number;
}

export interface CategoryFilters {
  /** The category's own tag slug. */
  slug: string;
  /** Count for the "All" chip — every open event in the category. */
  totalCount: number;
  filters: CategoryFilter[];
  /** True when this is a stale cache entry served because Gamma failed. */
  degraded: boolean;
}

/** polymarket.com's longest row today is politics at 24; 30 leaves headroom. */
const MAX_FILTERS = 30;
/** Sub-tag rows are curated by Polymarket and barely move day to day. */
const FRESH_TTL_MS = 10 * 60_000;
/** How long a last-good row may be served after Gamma starts failing. */
const STALE_TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 40;
/** Cap on in-flight upstream requests while resolving one row. */
const CONCURRENCY = 6;

interface CacheEntry {
  at: number;
  value: CategoryFilters;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Result<CategoryFilters, PolymarketError>>>();

/** Test hook. */
export const resetCategoryFiltersCache = (): void => {
  cache.clear();
  inflight.clear();
};

const remember = (slug: string, value: CategoryFilters): void => {
  cache.delete(slug);
  cache.set(slug, { at: Date.now(), value });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

/** Runs `worker` over `items` with at most `limit` in flight at once. */
const mapPooled = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await worker(item);
    }
  });
  await Promise.all(runners);
  return out;
};

/** Open-event count for a tag slug, or null when Gamma fails for that tag. */
const countFor = async (gamma: GammaClient, tagSlug: string): Promise<number | null> => {
  const page = await gamma.listEventsPaginated({
    limit: 1,
    offset: 0,
    active: true,
    closed: false,
    archived: false,
    tag_slug: tagSlug,
  });
  return page.ok ? page.value.pagination.totalResults : null;
};

const build = async (
  gamma: GammaClient,
  slug: string,
): Promise<Result<CategoryFilters, PolymarketError>> => {
  // The category's own "All" count doubles as the liveness probe: if this
  // fails the category itself is unreachable and there is no row to render.
  const [related, totalCount] = await Promise.all([
    gamma.listRelatedTags(slug),
    countFor(gamma, slug),
  ]);
  if (!related.ok) return err(related.error);

  const ranked = [...related.value].sort((a, b) => a.rank - b.rank).slice(0, MAX_FILTERS);

  const resolved = await mapPooled(ranked, CONCURRENCY, async (rel) => {
    const tag = await gamma.getTag(rel.relatedTagID);
    if (!tag.ok || tag.value === null) return null;
    const tagSlug = tag.value.slug;
    const label = tag.value.label;
    if (!tagSlug || !label) return null;
    const count = await countFor(gamma, tagSlug);
    // A failed count is indistinguishable from an empty tag here; drop it
    // rather than render a chip that leads to an empty grid.
    if (count === null || count === 0) return null;
    return { label, slug: tagSlug, count } satisfies CategoryFilter;
  });

  const value: CategoryFilters = {
    slug,
    totalCount: totalCount ?? 0,
    filters: resolved.filter((f): f is CategoryFilter => f !== null),
    degraded: false,
  };
  remember(slug, value);
  return ok(value);
};

/**
 * Sub-filters for one category, cached 10 min and served stale for up to an
 * hour when Gamma is failing.
 */
export const getCategoryFilters = async (
  gamma: GammaClient,
  slug: string,
): Promise<Result<CategoryFilters, PolymarketError>> => {
  const hit = cache.get(slug);
  const now = Date.now();
  if (hit && now - hit.at < FRESH_TTL_MS) return ok(hit.value);

  let job = inflight.get(slug);
  if (!job) {
    job = build(gamma, slug).finally(() => inflight.delete(slug));
    inflight.set(slug, job);
  }

  const outcome = await job;
  if (outcome.ok) return outcome;
  if (hit && now - hit.at < STALE_TTL_MS) return ok({ ...hit.value, degraded: true });
  return outcome;
};
