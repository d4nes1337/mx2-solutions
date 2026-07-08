/**
 * v2 trigger evidence: per-market summaries + the full evaluation result tree,
 * plus the v1-compatible flat fields for the primary market so downstream
 * consumers (trigger confirm UI, audit metadata) keep working unchanged.
 *
 * The definition hash is passed in by the caller and MUST be computed over the
 * ORIGINAL stored definition (v1 rules keep their v1 hash — see compat.ts).
 */
import { bestAsk, bestBid, spread } from "./predicates.js";
import { referencedTokenIds } from "./compat.js";
import type { MarketDataView, ReasonCode } from "./types.js";
import type {
  ExprResultNode,
  MarketEvidenceSummary,
  StrategyDefinition,
  TriggerEvidenceV2,
  ViewsByToken,
} from "./types-v2.js";

export const EVALUATOR_VERSION_V2 = "rules-engine/0.2.0";

const summarize = (view: MarketDataView): MarketEvidenceSummary => ({
  tokenId: view.tokenId,
  conditionId: view.conditionId,
  bestBid: bestBid(view),
  bestAsk: bestAsk(view),
  spread: spread(view),
  sourceTimeMs: view.sourceTimeMs,
  receivedAtMs: view.receivedAtMs,
  marketStatus: view.marketStatus,
});

/** The market whose flat fields fill the v1-compatible evidence slots. */
export const primaryTokenId = (def: StrategyDefinition): string => {
  if (def.action.kind === "order") return def.action.market.tokenId;
  return referencedTokenIds(def)[0] ?? "";
};

export const buildEvidenceV2 = (args: {
  def: StrategyDefinition;
  definitionHash: string;
  views: ViewsByToken;
  resultTree: ExprResultNode;
  windowStartMs: number;
  triggeredAtMs: number;
  reasonCodes: readonly ReasonCode[];
  triggerNumber: number;
}): TriggerEvidenceV2 => {
  const { def, definitionHash, views, resultTree, windowStartMs, triggeredAtMs } = args;

  const markets = referencedTokenIds(def)
    .map((t) => views[t])
    .filter((v): v is MarketDataView => v !== undefined)
    .map(summarize);

  const primary = views[primaryTokenId(def)] ?? Object.values(views)[0];

  return {
    evaluatorVersion: EVALUATOR_VERSION_V2,
    ruleDefinitionHash: definitionHash,
    windowStartMs,
    windowEndMs: triggeredAtMs,
    triggeredAtMs,
    markets,
    resultTree,
    reasonCodes: [...args.reasonCodes],
    preparedAction: def.action,
    triggerNumber: args.triggerNumber,
    tokenId: primary?.tokenId ?? primaryTokenId(def),
    conditionId: primary?.conditionId ?? "",
    bestBid: primary ? bestBid(primary) : null,
    bestAsk: primary ? bestAsk(primary) : null,
    spread: primary ? spread(primary) : null,
    sourceTimeMs: primary?.sourceTimeMs ?? triggeredAtMs,
    receivedAtMs: primary?.receivedAtMs ?? triggeredAtMs,
    marketStatus: primary?.marketStatus ?? "unknown",
  };
};
