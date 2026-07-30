/**
 * Category chips for the Markets browse grid, mirroring polymarket.com's main
 * nav row. Slugs are Gamma tag_slug values, each verified live 2026-07-29 to
 * resolve via /tags/slug/… AND to return open events via /events/pagination.
 * A wrong slug degrades to an Empty grid, never an error — but keep this list
 * in sync with what Gamma actually serves.
 *
 * Order and membership follow polymarket.com's nav as of 2026-07-29. Deliberate
 * differences from that nav, all because they are separate products rather than
 * tag filters over the same grid:
 *  - Trending is our "All" chip (their nav's leading `/` link);
 *  - Combos (parlays) and Perps (perpetual futures) are distinct products;
 *  - Mentions is a distinct product, and `mentions` is not a Gamma tag;
 *  - Breaking/New are orderings, not tags — `breaking` resolves as a tag but
 *    returns 0 open events, so a chip for it would always render empty;
 *  - Sports links to their /sports/live league-and-fixtures surface; here it is
 *    the `sports` tag like every other chip (owner decision, 2026-07-29).
 */
export const BROWSE_TAGS: { label: string; slug: string | null }[] = [
  { label: "All", slug: null },
  { label: "Politics", slug: "politics" },
  { label: "Sports", slug: "sports" },
  { label: "Crypto", slug: "crypto" },
  { label: "Esports", slug: "esports" },
  { label: "Iran", slug: "iran" },
  { label: "Finance", slug: "finance" },
  { label: "Geopolitics", slug: "geopolitics" },
  { label: "Tech", slug: "tech" },
  // Labelled "Culture" on polymarket.com, but the tag slug is `pop-culture` —
  // `culture` is not a Gamma tag and returns an empty grid.
  { label: "Culture", slug: "pop-culture" },
  { label: "Economy", slug: "economy" },
  { label: "Weather", slug: "weather" },
  { label: "Elections", slug: "elections" },
  { label: "Art", slug: "art" },
];

export const BROWSE_PAGE_SIZE = 20;
