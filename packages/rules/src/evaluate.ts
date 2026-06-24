/**
 * Pure predicate evaluation. Combines all predicates with AND (MVP), matching
 * the canonical WHEN clause in docs/04 §2. Returns per-predicate detail so the
 * "would-trigger-now" UI and the trigger evidence can show exactly which
 * predicate passed or failed and the live value that decided it.
 */
import { bestAsk, bestBid, cumulativeNotional, visibleLevels } from "./predicates.js";
import type {
  Evaluation,
  MarketDataView,
  Predicate,
  PredicateResult,
  ReasonCode,
  RuleDefinition,
} from "./types.js";

const evalPredicate = (p: Predicate, v: MarketDataView): PredicateResult => {
  switch (p.kind) {
    case "price": {
      const actual = p.source === "ask" ? bestAsk(v) : bestBid(v);
      const satisfied =
        actual !== null && (p.comparator === "lte" ? actual <= p.threshold : actual >= p.threshold);
      return {
        kind: "price",
        satisfied,
        actual,
        threshold: p.threshold,
        reason: satisfied ? "PRICE_OK" : "PRICE_FAIL",
      };
    }
    case "cumulative_notional": {
      const actual = cumulativeNotional(v, p.source, p.priceBound);
      const satisfied = actual >= p.minNotional;
      return {
        kind: "cumulative_notional",
        satisfied,
        actual,
        threshold: p.minNotional,
        reason: satisfied ? "NOTIONAL_OK" : "NOTIONAL_FAIL",
      };
    }
    case "visible_levels": {
      const actual = visibleLevels(v, p.source, p.priceBound);
      const satisfied = actual >= p.minLevels;
      return {
        kind: "visible_levels",
        satisfied,
        actual,
        threshold: p.minLevels,
        reason: satisfied ? "LEVELS_OK" : "LEVELS_FAIL",
      };
    }
  }
};

export const evaluatePredicates = (def: RuleDefinition, v: MarketDataView): Evaluation => {
  const results = def.predicates.map((p) => evalPredicate(p, v));
  const satisfied = results.length > 0 && results.every((r) => r.satisfied);
  const reasonCodes: ReasonCode[] = results.map((r) => r.reason);
  return { satisfied, results, reasonCodes };
};
