/**
 * v1 → v2 definition compatibility (ADR-0010). Stored v1 definitions are never
 * rewritten — the worker and the v2 API read them through this pure normalizer.
 * Node ids are deterministic ("root", "p0", "p1", …) so normalizing the same
 * v1 definition always yields the same v2 tree (parity tests depend on it).
 *
 * IMPORTANT: evidence hashes stay tied to the ORIGINAL stored definition. Hash
 * the raw definition before normalizing; never hash the normalized output of a
 * v1 rule.
 */
import type { Predicate, RuleDefinition } from "./types.js";
import type { ConditionV2, ExprNode, MarketRef, StrategyDefinition } from "./types-v2.js";

/** True when a stored JSONB definition is already v2. */
export const isV2Definition = (
  def: RuleDefinition | StrategyDefinition,
): def is StrategyDefinition => def.version === 2;

const toConditionV2 = (p: Predicate, market: MarketRef): ConditionV2 => {
  switch (p.kind) {
    case "price":
      return {
        kind: "price",
        market,
        source: p.source,
        comparator: p.comparator,
        threshold: p.threshold,
      };
    case "cumulative_notional":
      return {
        kind: "cumulative_notional",
        market,
        source: p.source,
        priceBound: p.priceBound,
        minNotional: p.minNotional,
      };
    case "visible_levels":
      return {
        kind: "visible_levels",
        market,
        source: p.source,
        priceBound: p.priceBound,
        minLevels: p.minLevels,
      };
  }
};

export const normalizeDefinition = (
  def: RuleDefinition | StrategyDefinition,
): StrategyDefinition => {
  if (isV2Definition(def)) return def;

  const market: MarketRef = {
    conditionId: def.conditionId,
    tokenId: def.tokenId,
    outcome: def.outcomeSide,
  };

  const expr: ExprNode = {
    type: "group",
    id: "root",
    op: "and",
    children: def.predicates.map((p, i) => ({
      type: "condition" as const,
      id: `p${i}`,
      condition: toConditionV2(p, market),
    })),
  };

  return {
    version: 2,
    name: "",
    templateId: null,
    expr,
    holdsForMs: def.continuousWindowMs,
    maxDataAgeMs: def.maxDataAgeMs,
    action: {
      kind: "order",
      market,
      side: def.action.side,
      price: def.action.price,
      size: def.action.size,
      orderType: def.action.orderType,
      execution: (def.executionMode ?? "manual") === "auto" ? "auto" : "prepare",
      ...(def.negRisk !== undefined ? { negRisk: def.negRisk } : {}),
      ...(def.tickSize !== undefined ? { tickSize: def.tickSize } : {}),
    },
    recurrence: { kind: "once" },
    limits: null,
    expiresAtMs: def.expiresAtMs,
  };
};

/** Every tokenId the strategy reads or trades — the worker's subscription set. */
export const referencedTokenIds = (def: StrategyDefinition): readonly string[] => {
  const tokens = new Set<string>();
  const walk = (node: ExprNode): void => {
    if (node.type === "condition") {
      if (node.condition.kind !== "time_window") tokens.add(node.condition.market.tokenId);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(def.expr);
  if (def.action.kind === "order") tokens.add(def.action.market.tokenId);
  return [...tokens];
};

/** All condition leaves in document order (builder + validation helpers). */
export const conditionLeaves = (
  expr: ExprNode,
): readonly { readonly id: string; readonly condition: ConditionV2 }[] => {
  if (expr.type === "condition") return [{ id: expr.id, condition: expr.condition }];
  return expr.children.flatMap(conditionLeaves);
};
