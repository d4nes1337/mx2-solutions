import type { MarketSearchHit } from "./market-search.js";

/**
 * Lightweight query understanding for the pass-through market search:
 * normalize the raw text, extract an optional date window, and emit up to
 * three Gamma fan-out queries from a static synonym table. Pure and
 * deterministic — `nowMs` is injected so date parsing is unit-testable.
 *
 * Date tokens are REMOVED from the text queries: Gamma /public-search matches
 * text, not dates, so "messi scores 19.07" searches "messi scores" and the
 * date only participates in local re-ranking against hit endDates.
 */

export interface DateWindow {
  startMs: number;
  endMs: number;
}

export interface UnderstoodQuery {
  original: string;
  cleaned: string;
  dateWindow: DateWindow | null;
  /** [cleaned, ...synonym expansions], deduped, max 3. */
  queries: string[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A named day matches hits ±36h around it (events end near, not on, the day). */
const DATE_WINDOW_HALF_MS = 36 * HOUR_MS;
/** Day-months further than this in the past roll over to next year. */
const PAST_ROLLOVER_MS = 30 * DAY_MS;
const MAX_QUERIES = 3;

const FILLER = new Set(["will", "the", "market", "a", "on", "in"]);

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

// Longest names first so "january" wins over "jan" in the alternation.
const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

// "19.07" / "19/07" / "7/19". The dot form requires a 2-digit month so
// decimals like "1.5" or "0.45" never read as dates.
const NUMERIC_DATE_RE = /\b(\d{1,2})(?:\.(\d{2})|\/(\d{1,2}))\b/g;
const MONTH_DAY_RE = new RegExp(String.raw`\b(${MONTH_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?\b`);
const DAY_MONTH_RE = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\b`);
const RELATIVE_RE = /\b(today|tomorrow)\b/;

/** Static expansions (≤2 extra queries). Multi-word keys before their prefixes. */
const SYNONYMS: readonly (readonly [string, string])[] = [
  ["world cup", "fifa world cup"],
  ["wc", "fifa world cup"],
  ["scores", "goals"],
  ["cs2", "counter-strike"],
  ["usa", "united states"],
  ["uk", "united kingdom"],
  ["btc", "bitcoin"],
  ["eth", "ethereum"],
  ["fed", "federal reserve"],
];

const anchorForDayMonth = (day: number, month: number, nowMs: number): number | null => {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const year = new Date(nowMs).getUTCFullYear();
  // Noon UTC keeps the ±36h window tolerant of the searcher's timezone.
  const anchor = Date.UTC(year, month - 1, day, 12);
  if (anchor < nowMs - PAST_ROLLOVER_MS) return Date.UTC(year + 1, month - 1, day, 12);
  return anchor;
};

const windowAround = (anchorMs: number): DateWindow => ({
  startMs: anchorMs - DATE_WINDOW_HALF_MS,
  endMs: anchorMs + DATE_WINDOW_HALF_MS,
});

const cut = (text: string, match: RegExpMatchArray): string =>
  `${text.slice(0, match.index ?? 0)} ${text.slice((match.index ?? 0) + match[0].length)}`;

const extractDate = (
  text: string,
  nowMs: number,
): { remaining: string; window: DateWindow | null } => {
  const relative = RELATIVE_RE.exec(text);
  if (relative) {
    const anchor = relative[1] === "today" ? nowMs : nowMs + DAY_MS;
    return { remaining: cut(text, relative), window: windowAround(anchor) };
  }
  const monthDay = MONTH_DAY_RE.exec(text);
  if (monthDay) {
    const anchor = anchorForDayMonth(Number(monthDay[2]), MONTHS[monthDay[1]!]!, nowMs);
    if (anchor !== null) return { remaining: cut(text, monthDay), window: windowAround(anchor) };
  }
  const dayMonth = DAY_MONTH_RE.exec(text);
  if (dayMonth) {
    const anchor = anchorForDayMonth(Number(dayMonth[1]), MONTHS[dayMonth[2]!]!, nowMs);
    if (anchor !== null) return { remaining: cut(text, dayMonth), window: windowAround(anchor) };
  }
  for (const match of text.matchAll(NUMERIC_DATE_RE)) {
    const a = Number(match[1]);
    const b = Number(match[2] ?? match[3]);
    // Day-first ("19.07"); swapped only when day-first can't be a date ("7/19").
    const anchor = anchorForDayMonth(a, b, nowMs) ?? anchorForDayMonth(b, a, nowMs);
    if (anchor !== null) return { remaining: cut(text, match), window: windowAround(anchor) };
  }
  return { remaining: text, window: null };
};

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

export const understandQuery = (raw: string, nowMs: number): UnderstoodQuery => {
  const { remaining, window } = extractDate(raw.toLowerCase(), nowMs);
  const tokens = tokenize(remaining);
  const content = tokens.filter((t) => !FILLER.has(t));
  // All-filler queries ("will the market") keep their tokens rather than
  // degrading to an empty Gamma query.
  const cleaned = (content.length > 0 ? content : tokens).join(" ");

  const queries: string[] = cleaned ? [cleaned] : [];
  for (const [key, replacement] of SYNONYMS) {
    if (!cleaned || queries.length >= MAX_QUERIES) break;
    if (cleaned.includes(replacement)) continue;
    const keyRe = new RegExp(String.raw`\b${key}\b`);
    if (!keyRe.test(cleaned)) continue;
    const expanded = cleaned.replace(keyRe, replacement).replace(/\s+/g, " ").trim();
    if (!queries.includes(expanded)) queries.push(expanded);
  }

  return { original: raw, cleaned, dateWindow: window, queries };
};

/**
 * Deterministic local re-rank: 3·lexicalOverlap + 2·dateFit +
 * log10(liquidity+volume+1)/10 — text fit dominates, a matching end date
 * beats depth, depth breaks ties. Dedups by conditionId (first wins).
 */
export const rankHits = (hits: MarketSearchHit[], uq: UnderstoodQuery): MarketSearchHit[] => {
  const queryTokens = new Set(uq.queries.flatMap(tokenize));

  const scoreOf = (hit: MarketSearchHit): number => {
    let lexical = 0;
    if (queryTokens.size > 0) {
      const text = new Set(tokenize(`${hit.title} ${hit.eventTitle}`));
      let matched = 0;
      for (const token of queryTokens) if (text.has(token)) matched++;
      lexical = matched / queryTokens.size;
    }

    let dateFit = 0;
    if (uq.dateWindow && hit.endDate) {
      const endMs = Date.parse(hit.endDate);
      if (Number.isFinite(endMs)) {
        if (endMs >= uq.dateWindow.startMs && endMs <= uq.dateWindow.endMs) {
          dateFit = 1;
        } else {
          const distMs =
            endMs < uq.dateWindow.startMs
              ? uq.dateWindow.startMs - endMs
              : endMs - uq.dateWindow.endMs;
          dateFit = 1 / (1 + distMs / DAY_MS);
        }
      }
    }

    const liquidity = Number(hit.liquidity);
    const volume = Number(hit.volume);
    const depth =
      (Number.isFinite(liquidity) ? liquidity : 0) + (Number.isFinite(volume) ? volume : 0);

    return 3 * lexical + 2 * dateFit + Math.log10(Math.max(depth, 0) + 1) / 10;
  };

  const seen = new Set<string>();
  return hits
    .filter((hit) => (seen.has(hit.conditionId) ? false : (seen.add(hit.conditionId), true)))
    .map((hit, index) => ({ hit, score: scoreOf(hit), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.hit);
};
