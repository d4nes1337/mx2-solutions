/**
 * Curated category chips for the Markets browse grid, mirroring polymarket.com's
 * main nav. Slugs are Gamma tag_slug values (verified live 2026-07-27 via
 * /events/pagination?tag_slug=…). A wrong slug degrades to an Empty grid, never
 * an error — but keep this list in sync with what Gamma actually serves.
 */
export const BROWSE_TAGS: { label: string; slug: string | null }[] = [
  { label: "All", slug: null },
  { label: "Politics", slug: "politics" },
  { label: "Sports", slug: "sports" },
  { label: "Crypto", slug: "crypto" },
  { label: "Finance", slug: "finance" },
  { label: "Geopolitics", slug: "geopolitics" },
  { label: "Tech", slug: "tech" },
  { label: "Culture", slug: "culture" },
  { label: "World", slug: "world" },
  { label: "Economy", slug: "economy" },
];

export const BROWSE_PAGE_SIZE = 20;
