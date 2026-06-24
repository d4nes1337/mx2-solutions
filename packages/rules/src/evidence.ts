/**
 * Trigger evidence + a deterministic content hash of a rule definition. The
 * hash ties a trigger to the exact rule version (docs/04 §5). It is a content
 * fingerprint (FNV-1a over canonical JSON), not a cryptographic commitment.
 */
import {
  bestAsk,
  bestBid,
  cumulativeNotional,
  cumulativeShares,
  spread,
  visibleLevels,
} from "./predicates.js";
import type {
  CumulativeNotionalCondition,
  MarketDataView,
  ReasonCode,
  RuleDefinition,
  TriggerEvidence,
  VisibleLevelsCondition,
} from "./types.js";

export const EVALUATOR_VERSION = "rules-engine/0.1.0";

/** Recursively sort object keys so equal definitions serialize identically. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonical((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
};

/** FNV-1a 32-bit hash rendered as 8 hex chars. Deterministic, dependency-free. */
export const hashDefinition = (def: RuleDefinition): string => {
  const json = JSON.stringify(canonical(def));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/** First cumulative_notional / visible_levels predicate, if any (for evidence). */
const firstNotional = (def: RuleDefinition): CumulativeNotionalCondition | null =>
  (def.predicates.find((p) => p.kind === "cumulative_notional") as
    | CumulativeNotionalCondition
    | undefined) ?? null;

const firstLevels = (def: RuleDefinition): VisibleLevelsCondition | null =>
  (def.predicates.find((p) => p.kind === "visible_levels") as VisibleLevelsCondition | undefined) ??
  null;

export const buildEvidence = (args: {
  def: RuleDefinition;
  view: MarketDataView;
  windowStartMs: number;
  triggeredAtMs: number;
  reasonCodes: readonly ReasonCode[];
}): TriggerEvidence => {
  const { def, view, windowStartMs, triggeredAtMs, reasonCodes } = args;
  const notionalP = firstNotional(def);
  const levelsP = firstLevels(def);
  return {
    evaluatorVersion: EVALUATOR_VERSION,
    ruleDefinitionHash: hashDefinition(def),
    tokenId: def.tokenId,
    conditionId: def.conditionId,
    windowStartMs,
    windowEndMs: triggeredAtMs,
    triggeredAtMs,
    bestBid: bestBid(view),
    bestAsk: bestAsk(view),
    spread: spread(view),
    cumulativeNotional: notionalP
      ? cumulativeNotional(view, notionalP.source, notionalP.priceBound)
      : null,
    cumulativeShares: notionalP
      ? cumulativeShares(view, notionalP.source, notionalP.priceBound)
      : null,
    visibleLevels: levelsP ? visibleLevels(view, levelsP.source, levelsP.priceBound) : null,
    sourceTimeMs: view.sourceTimeMs,
    receivedAtMs: view.receivedAtMs,
    marketStatus: view.marketStatus,
    reasonCodes: [...reasonCodes],
    preparedAction: def.action,
  };
};
