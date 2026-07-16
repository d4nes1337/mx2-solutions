/**
 * Thin adapter over the canonical template specs (@mx2/rules/templates): a
 * spec's StrategyDefinition becomes a laid-out builder doc. Copy, structure
 * and AI few-shots all live in the spec — edit THERE, not here.
 */
import { TEMPLATE_SPECS, templateSpecById, type MarketRef } from "@mx2/rules";
import { UNBOUND, docFromDefinition, type MarketMeta, type StrategyDoc } from "./doc";
import { layoutDoc } from "./layout";

export interface TemplateDef {
  id: string;
  name: string;
  blurb: string;
  example: string;
  /** Ready-to-send AI prompt line (hero carousel / chat seeds). */
  prompt: string;
  build: (market?: MarketRef, meta?: MarketMeta) => StrategyDoc;
}

const toDef = (spec: (typeof TEMPLATE_SPECS)[number]): TemplateDef => ({
  id: spec.id,
  name: spec.name,
  blurb: spec.blurb,
  example: spec.example,
  prompt: spec.prompt,
  build: (market = UNBOUND, meta) => {
    const doc = docFromDefinition(spec.buildDefinition(market));
    if (market.tokenId !== "" && meta) doc.marketMeta[market.tokenId] = meta;
    return layoutDoc(doc);
  },
});

/**
 * Builder-openable templates only: flagged specs (the rebate-farm maker loop)
 * are designed in the farming cockpit, not the canvas — the gallery links
 * them there instead.
 */
export const TEMPLATES: readonly TemplateDef[] = TEMPLATE_SPECS.filter(
  (s) => s.flag === null,
).map(toDef);

export const templateById = (id: string): TemplateDef | null => {
  const spec = templateSpecById(id);
  return spec && spec.flag === null ? toDef(spec) : null;
};
