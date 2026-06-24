// Client-side helpers for the rule builder. The AUTHORITATIVE evaluation lives
// server-side in @mx2/rules (the worker + /evaluate-now); this is only for an
// instant "would-trigger-now" preview before a rule is created, so small drift
// is acceptable. It deliberately mirrors packages/rules/src/predicates.ts.

import type { OrderLevel, OrderSide, RulePredicateInput } from "./types";

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

const round6 = (n: number): number => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

const toLevels = (raw: OrderLevel[] | undefined, side: "ask" | "bid") =>
  (raw ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));

export interface ClientPredResult {
  satisfied: boolean;
  actual: number | null;
  label: string;
}

/** Build the canonical predicate set for a one-sided BUY/SELL rule. */
export function buildPredicates(opts: {
  side: OrderSide;
  priceThreshold: number;
  liquidity: boolean;
  minNotional: number;
  minLevels: number;
}): RulePredicateInput[] {
  const source = opts.side === "BUY" ? "ask" : "bid";
  const comparator = opts.side === "BUY" ? "lte" : "gte";
  const preds: RulePredicateInput[] = [
    { kind: "price", source, comparator, threshold: opts.priceThreshold },
  ];
  if (opts.liquidity) {
    preds.push({
      kind: "cumulative_notional",
      source,
      priceBound: opts.priceThreshold,
      minNotional: opts.minNotional,
    });
    preds.push({
      kind: "visible_levels",
      source,
      priceBound: opts.priceThreshold,
      minLevels: opts.minLevels,
    });
  }
  return preds;
}

export function evalPredicatesClient(
  preds: RulePredicateInput[],
  bids: OrderLevel[] | undefined,
  asks: OrderLevel[] | undefined,
): ClientPredResult[] {
  const a = toLevels(asks, "ask");
  const b = toLevels(bids, "bid");
  const best = (s: "ask" | "bid") => (s === "ask" ? (a[0]?.price ?? null) : (b[0]?.price ?? null));
  const inBand = (s: "ask" | "bid", bound: number) =>
    s === "ask" ? a.filter((l) => l.price <= bound) : b.filter((l) => l.price >= bound);

  return preds.map((p) => {
    const op = (s: "ask" | "bid") => (s === "ask" ? "≤" : "≥");
    if (p.kind === "price") {
      const actual = best(p.source);
      const t = p.threshold ?? 0;
      const sat = actual !== null && (p.comparator === "lte" ? actual <= t : actual >= t);
      return {
        satisfied: sat,
        actual,
        label: `best ${p.source} ${p.comparator === "lte" ? "≤" : "≥"} ${t}`,
      };
    }
    if (p.kind === "cumulative_notional") {
      const bound = p.priceBound ?? 0;
      const actual = round6(inBand(p.source, bound).reduce((s, l) => s + l.price * l.size, 0));
      const t = p.minNotional ?? 0;
      return {
        satisfied: actual >= t,
        actual,
        label: `Σ notional (${p.source} ${op(p.source)} ${bound}) ≥ $${t}`,
      };
    }
    const bound = p.priceBound ?? 0;
    const actual = inBand(p.source, bound).filter((l) => l.size > 0).length;
    const t = p.minLevels ?? 0;
    return {
      satisfied: actual >= t,
      actual,
      label: `visible levels (${p.source} ${op(p.source)} ${bound}) ≥ ${t}`,
    };
  });
}
