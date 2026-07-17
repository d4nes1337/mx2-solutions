/**
 * Best-fit strategy suggestion for a live feed event (Slice 6, AutomateNow).
 * Pure heuristics over the primary market's mid/volume; the prompt is a
 * plain-language sentence a user could have typed — it goes straight into
 * /smart-orders/new?prompt= (Slices 1+2 make one-click drafting reliable).
 */
import type { GammaEvent } from "../types";
import { primaryMarket, yesProbability } from "../feeds";
import { toNum } from "../format";

export interface StrategySuggestion {
  label: string;
  prompt: string;
}

/** 24h event volume above this reads as "in play" → momentum alert. */
export const HIGH_VOLUME_24H_USD = 50_000;

const title = (event: GammaEvent): string => {
  const market = primaryMarket(event);
  const raw = market?.question || event.title || "";
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
};

export function suggestStrategyFor(event: GammaEvent): StrategySuggestion | null {
  const market = primaryMarket(event);
  if (!market) return null;

  const mid = yesProbability(market);
  // Near-resolved or unpriced markets aren't automatable — no suggestion.
  if (!Number.isFinite(mid) || mid < 0.02 || mid > 0.98) return null;

  const cents = Math.round(mid * 100);
  const name = title(event);
  if (!name) return null;

  if (mid >= 0.35 && mid <= 0.65) {
    const entry = cents - 5;
    return {
      label: `Dip-buy below ${entry}¢`,
      prompt: `Buy $100 of YES on "${name}" if the price dips below ${entry}¢ and holds for 15 minutes`,
    };
  }

  if (mid > 0.75) {
    return {
      label: "Trailing-stop protect",
      prompt: `I hold YES on "${name}" — sell my position at the best price if it drops 8 cents from its peak`,
    };
  }

  if (toNum(event.volume24hr) >= HIGH_VOLUME_24H_USD) {
    return {
      label: "Momentum alert",
      prompt: `Alert me if "${name}" spikes 5 cents within an hour`,
    };
  }

  const threshold = Math.min(95, cents + 3);
  return {
    label: `Threshold entry above ${threshold}¢`,
    prompt: `Buy $100 of YES on "${name}" if it holds above ${threshold}¢ for 2 hours`,
  };
}
