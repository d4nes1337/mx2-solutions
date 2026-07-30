"use client";

/**
 * The strategy's secondary facts — markets, last engine check, trigger count,
 * exposure, expiry, recurrence — as one compact line. Lives in the side panel
 * and detail surfaces; the dashboard card stays down to essentials.
 */
import { docFromDefinition, docMarketRefs, marketLabel } from "@/lib/strategies/doc";
import { humanDuration } from "@/lib/strategies/sentence";
import { useNow } from "@/lib/strategies/use-now";
import type { StrategyRow } from "@/lib/strategies/queries";

export const timeAgo = (iso: string | null): string => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

export const timeLeft = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5_400) return `${Math.round(s / 60)}m`;
  if (s < 129_600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
};

/** Estimated exposure: order cost, or the auto limits when armed. */
export const exposure = (row: StrategyRow): string | null => {
  const a = row.definitionV2.action;
  if (a.kind !== "order") return null;
  const cost = a.price * a.size;
  if (a.execution === "auto" && row.definitionV2.limits) {
    return `up to $${row.definitionV2.limits.maxTotalNotional.toLocaleString()}`;
  }
  return `≈ $${cost.toFixed(2)}`;
};

export function MetaRow({ row }: { row: StrategyRow }) {
  const now = useNow();
  const def = row.definitionV2;
  const doc = docFromDefinition(def);
  const markets = docMarketRefs(doc);
  return (
    <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
      {markets.slice(0, 2).map((m) => (
        <span key={m.tokenId} className="truncate">
          {marketLabel(doc, m)}
        </span>
      ))}
      <span>last check {timeAgo(row.lastEvaluatedAt)}</span>
      {row.triggerCount > 0 ? <span>triggered {row.triggerCount}×</span> : null}
      {exposure(row) ? <span>exposure {exposure(row)}</span> : null}
      {row.expiresAt !== null && new Date(row.expiresAt).getTime() > now ? (
        <span>expires in {timeLeft(new Date(row.expiresAt).getTime() - now)}</span>
      ) : null}
      {def.recurrence.kind === "repeat" ? (
        <span>
          repeats {row.triggerCount}/{def.recurrence.maxRepeats} ·{" "}
          {humanDuration(def.recurrence.cooldownMs)} cooldown
        </span>
      ) : null}
    </div>
  );
}
