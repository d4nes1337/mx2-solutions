/**
 * Distance-to-trigger ("proximity") ranking for the Smart Orders dashboard.
 *
 * Folds the result tree of `evaluateExpression` into one ascending rank per
 * strategy (smaller = closer to firing): a strategy whose hold window is
 * already running always ranks ahead of any waiting one (rank = −1 −
 * dwellFraction ∈ [−2,−1], more complete = smaller), otherwise the rank is the
 * binding constraint's volatility-normalized distance — AND takes the worst
 * (max) child because every branch must clear, OR takes the best (min) because
 * one is enough. Price-like leaves measure |actual − threshold| in probability
 * units; boolean gates (liquidity/depth/time/spread) and un-armed trailing
 * stops never pretend to have a price distance — they carry a fixed penalty
 * rank plus a `blockedBy` label instead.
 *
 * Ranking asymmetry vs. the evaluator: SATISFACTION stays globally fail-closed
 * on staleness (evaluate-v2.ts), but for ranking an OR may route around a
 * stale branch — a fresh reachable path is honestly "close" even while a
 * sibling's data is stale. A stale binding path sorts last via `staleRank`.
 */
import { evaluateExpression } from "./evaluate-v2.js";
import type { PriceSample } from "./types.js";
import type {
  ConditionV2,
  ExprNode,
  ExprResultNode,
  StrategyDefinition,
  ViewsByToken,
  WatermarksByNode,
} from "./types-v2.js";

/** Tuning constants, exported for tests and the dashboard cutoff knob. */
export const PROXIMITY = {
  /** Floor for typical movement so normalization can't divide by ~0 (0.5¢). */
  minTypicalMove: 0.005,
  /** Assumed typical move when a token has no usable history (1¢). */
  defaultTypicalMove: 0.01,
  /** Rank for unsatisfied boolean gates — never displayed as "N¢ away". */
  blockedRank: 1e6,
  /** Rank when the binding path's data is missing/stale (sorts dead last). */
  staleRank: 2e6,
  /** |recent drift| below this reads as "flat" (half the typical-move floor). */
  flatDriftEps: 0.0025,
} as const;

export interface LeafProximity {
  readonly nodeId: string;
  readonly kind: ConditionV2["kind"];
  readonly tokenId: string | null;
  readonly satisfied: boolean;
  readonly stale: boolean;
  /** Distance to satisfaction in probability units; null for gates/stale. */
  readonly rawDistance: number | null;
  /** rawDistance ÷ typical move, or a penalty constant. The ranking unit. */
  readonly normDistance: number;
  /** Label when a non-price gate blocks: "liquidity" | "depth" | "time" | "spread" | "arming". */
  readonly blockedBy: string | null;
}

export interface StrategyProximity {
  /** Ascending = closer. Dwell −1−fraction; else binding normalized distance. */
  readonly rank: number;
  /** Binding leaf's raw distance (prob units) for "2.3¢ away"; null when gated/stale. */
  readonly bindingDistance: number | null;
  readonly bindingNodeId: string | null;
  readonly bindingTokenId: string | null;
  /** 0..1 hold-window progress; null unless the caller passed trueSinceMs. */
  readonly dwellFraction: number | null;
  /** Gate labels blocking the binding AND path; [] when price-bound. */
  readonly blockedBy: readonly string[];
  /** Recent-drift verdict for the binding token (null without drift data). */
  readonly drift: "approaching" | "retreating" | "flat" | null;
  readonly leaves: readonly LeafProximity[];
}

export interface ProximityOptions {
  readonly watermarks?: WatermarksByNode;
  /** Row's trueSince (ms). Pass only while ACTIVE_ACCUMULATING. */
  readonly trueSinceMs?: number | null;
  /** Per-token typical movement (mean |Δp| of recent history), prob units. */
  readonly typicalMoveByToken?: Readonly<Record<string, number>>;
  /** Per-token signed recent change (last − earlier), prob units. */
  readonly driftByToken?: Readonly<Record<string, number>>;
}

/** Mean absolute step between consecutive samples; null when < 3 points. */
export const typicalMovement = (history: readonly PriceSample[]): number | null => {
  if (history.length < 3) return null;
  let sum = 0;
  for (let i = 1; i < history.length; i++) sum += Math.abs(history[i]!.p - history[i - 1]!.p);
  return sum / (history.length - 1);
};

/**
 * Signed change from the newest sample at/before (last.t − lookbackMs) to the
 * last sample. Null when the history doesn't reach back that far.
 */
export const recentDrift = (history: readonly PriceSample[], lookbackMs: number): number | null => {
  if (history.length < 2) return null;
  const last = history[history.length - 1]!;
  const cutoff = last.t - lookbackMs;
  for (let i = history.length - 2; i >= 0; i--) {
    const s = history[i]!;
    if (s.t <= cutoff) return last.p - s.p;
  }
  return null;
};

const GATE_LABELS: Partial<Record<ConditionV2["kind"], string>> = {
  cumulative_notional: "liquidity",
  visible_levels: "depth",
  time_window: "time",
  spread: "spread",
};

/** Which price direction moves a leaf toward satisfaction (for drift). */
const desiredDirection = (c: ConditionV2): "down" | "up" | "any" | null => {
  switch (c.kind) {
    case "price":
      return c.comparator === "lte" ? "down" : "up";
    case "trailing":
      return c.mode === "stop" ? "down" : "up";
    case "price_move":
      return c.direction === "drop" ? "down" : c.direction === "rise" ? "up" : "any";
    default:
      return null;
  }
};

const conditionsById = (
  node: ExprNode,
  out: Map<string, ConditionV2>,
): Map<string, ConditionV2> => {
  if (node.type === "condition") out.set(node.id, node.condition);
  else for (const child of node.children) conditionsById(child, out);
  return out;
};

/** Binding-constraint info propagated up the fold. */
interface FoldOut {
  readonly normDistance: number;
  readonly rawDistance: number | null;
  readonly nodeId: string | null;
  readonly tokenId: string | null;
  readonly blocked: readonly string[];
}

const BLOCKED_EMPTY: FoldOut = {
  normDistance: PROXIMITY.blockedRank,
  rawDistance: null,
  nodeId: null,
  tokenId: null,
  blocked: ["empty"],
};

export const strategyProximity = (
  def: StrategyDefinition,
  views: ViewsByToken,
  nowMs: number,
  opts: ProximityOptions = {},
): StrategyProximity => {
  const evaluation = evaluateExpression(def, views, nowMs, opts.watermarks ?? {});
  const byId = conditionsById(def.expr, new Map());
  const leaves: LeafProximity[] = [];

  const normFor = (tokenId: string | null, raw: number): number => {
    const typical = tokenId !== null ? opts.typicalMoveByToken?.[tokenId] : undefined;
    return raw / Math.max(typical ?? PROXIMITY.defaultTypicalMove, PROXIMITY.minTypicalMove);
  };

  const foldLeaf = (node: Extract<ExprResultNode, { type: "condition" }>): FoldOut => {
    const r = node.result;
    const c = byId.get(node.id);
    const gateLabel = c !== undefined ? (GATE_LABELS[c.kind] ?? null) : null;
    const arming = r.kind === "trailing" && r.reason === "TRAILING_ARMING";

    let rawDistance: number | null = null;
    let normDistance: number;
    let blockedBy: string | null = null;
    if (r.satisfied) {
      rawDistance = 0;
      normDistance = 0;
    } else if (r.stale) {
      normDistance = PROXIMITY.staleRank;
    } else if (arming) {
      normDistance = PROXIMITY.blockedRank;
      blockedBy = "arming";
    } else if (gateLabel !== null) {
      normDistance = PROXIMITY.blockedRank;
      blockedBy = gateLabel;
    } else if (r.actual !== null) {
      // price / trailing / price_move: distance to the (effective) threshold.
      rawDistance =
        r.kind === "price_move"
          ? Math.max(0, r.threshold - r.actual)
          : Math.abs(r.actual - r.threshold);
      normDistance = normFor(r.tokenId, rawDistance);
    } else {
      normDistance = PROXIMITY.staleRank;
    }

    leaves.push({
      nodeId: node.id,
      kind: r.kind,
      tokenId: r.tokenId,
      satisfied: r.satisfied,
      stale: r.stale,
      rawDistance,
      normDistance,
      blockedBy,
    });
    return {
      normDistance,
      rawDistance,
      nodeId: node.id,
      tokenId: r.tokenId,
      blocked: blockedBy !== null ? [blockedBy] : [],
    };
  };

  const fold = (node: ExprResultNode): FoldOut => {
    if (node.type === "condition") return foldLeaf(node);
    if (node.op === "not") {
      // A NOT branch is a boolean gate: there is no honest cents-distance to
      // "stop being true", so it's either clear (0) or blocking.
      return node.satisfied
        ? { normDistance: 0, rawDistance: 0, nodeId: node.id, tokenId: null, blocked: [] }
        : {
            normDistance: PROXIMITY.blockedRank,
            rawDistance: null,
            nodeId: node.id,
            tokenId: null,
            blocked: ["condition"],
          };
    }
    const children = node.children.map(fold);
    if (children.length === 0) return BLOCKED_EMPTY;
    // AND binds on the worst (max) child — every branch must clear; OR binds
    // on the best (min) — one path suffices. First child wins ties (stable).
    let binding = children[0]!;
    for (const child of children.slice(1)) {
      if (
        node.op === "or"
          ? child.normDistance < binding.normDistance
          : child.normDistance > binding.normDistance
      )
        binding = child;
    }
    // An AND is blocked by every gated child, not just the max one.
    const blocked =
      node.op === "and" ? [...new Set(children.flatMap((c) => c.blocked))] : binding.blocked;
    return { ...binding, blocked };
  };

  const bound = fold(evaluation.root);

  let dwellFraction: number | null = null;
  if (opts.trueSinceMs !== null && opts.trueSinceMs !== undefined) {
    dwellFraction =
      def.holdsForMs > 0
        ? Math.min(1, Math.max(0, (nowMs - opts.trueSinceMs) / def.holdsForMs))
        : 1;
  }
  const rank = dwellFraction !== null ? -1 - dwellFraction : bound.normDistance;

  let drift: StrategyProximity["drift"] = null;
  const bindingCondition = bound.nodeId !== null ? byId.get(bound.nodeId) : undefined;
  const driftValue = bound.tokenId !== null ? opts.driftByToken?.[bound.tokenId] : undefined;
  if (bindingCondition !== undefined && driftValue !== undefined) {
    const desired = desiredDirection(bindingCondition);
    if (desired !== null) {
      if (Math.abs(driftValue) < PROXIMITY.flatDriftEps) drift = "flat";
      else if (desired === "any") drift = "approaching";
      else if (desired === "down") drift = driftValue < 0 ? "approaching" : "retreating";
      else drift = driftValue > 0 ? "approaching" : "retreating";
    }
  }

  const bindingBlocked = bound.normDistance >= PROXIMITY.blockedRank;
  return {
    rank,
    bindingDistance: bindingBlocked ? null : bound.rawDistance,
    bindingNodeId: bound.nodeId,
    bindingTokenId: bound.tokenId,
    dwellFraction,
    blockedBy: bound.blocked,
    drift,
    leaves,
  };
};
