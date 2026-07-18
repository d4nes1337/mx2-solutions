/**
 * Plain-English one-liners for conditions and their live readings — shared by
 * the builder canvas nodes and the strategy detail page so both surfaces
 * describe a condition with exactly the same words.
 */
import type { ConditionV2 } from "@mx2/rules";
import { marketLabel, type StrategyDoc } from "./doc";

export const cents = (p: number): string => `${Math.round(p * 100)}¢`;
export const usd = (n: number): string => `$${n.toLocaleString()}`;

export const conditionSummary = (
  doc: StrategyDoc,
  c: ConditionV2,
): { summary: string; detail: string | null } => {
  switch (c.kind) {
    case "price":
      return {
        summary: `${c.market.outcome} price ${c.comparator === "lte" ? "below" : "above"} ${cents(c.threshold)}`,
        detail: marketLabel(doc, c.market),
      };
    case "spread":
      return {
        summary: `Spread ${c.comparator === "lte" ? "under" : "over"} ${cents(c.threshold)}`,
        detail: marketLabel(doc, c.market),
      };
    case "cumulative_notional":
      return {
        summary: `Liquidity ≥ ${usd(c.minNotional)} up to ${cents(c.priceBound)}`,
        detail: marketLabel(doc, c.market),
      };
    case "visible_levels":
      return {
        summary: `≥ ${c.minLevels} book levels up to ${cents(c.priceBound)}`,
        detail: marketLabel(doc, c.market),
      };
    case "time_window":
      return { summary: "Within a time window", detail: null };
    case "price_move":
      return {
        summary: `${c.market.outcome} ${c.direction === "drop" ? "drops" : c.direction === "rise" ? "rises" : "moves"} ${cents(c.deltaThreshold)}+ in ${Math.round(c.windowMs / 60_000)}m`,
        detail: marketLabel(doc, c.market),
      };
    case "trailing":
      return {
        summary:
          c.mode === "stop"
            ? `${c.market.outcome} falls ${cents(c.offset)} from its peak`
            : `${c.market.outcome} rebounds ${cents(c.offset)} off its low`,
        detail: marketLabel(doc, c.market),
      };
  }
};

export const formatActual = (kind: ConditionV2["kind"], actual: number | null): string | null => {
  if (actual === null) return null;
  switch (kind) {
    case "price":
    case "spread":
    case "price_move":
    case "trailing":
      return cents(actual);
    case "cumulative_notional":
      return usd(Math.round(actual));
    case "visible_levels":
      return String(actual);
    case "time_window":
      return null;
  }
};
