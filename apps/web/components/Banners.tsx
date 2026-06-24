"use client";

import { useFeatureFlags, useTradeStatus } from "@/lib/queries";
import { Badge } from "./ui";

// Fail-closed banner shown when the live orderbook snapshot is stale. Mirrors
// the backend's stale policy — the UI must not present confident execution prices.
export function StaleBanner({ source }: { source?: string }) {
  return (
    <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
      ⚠ Orderbook data is <strong>stale</strong>
      {source ? ` (source: ${source})` : ""}. Prices may be out of date — execution is held back
      until fresh data arrives.
    </div>
  );
}

// Honest, always-visible explanation of trading state so a disabled order
// ticket is never mysterious. Reads /api/feature-flags + /api/trade/status.
export function TradingStatusBanner() {
  const flags = useFeatureFlags();
  const status = useTradeStatus();

  const liveTrading = flags.data?.liveTrading ?? false;
  const geo = status.data?.geoblock;
  const paused = status.data?.runtimePaused;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
      <span className="font-semibold text-fg">Trading status:</span>
      <Badge tone={liveTrading ? "pos" : "warn"}>
        live trading {liveTrading ? "ENABLED" : "DISABLED"}
      </Badge>
      {paused ? <Badge tone="neg">kill-switch: PAUSED</Badge> : null}
      {geo ? (
        <Badge tone={geo.status === "allowed" ? "pos" : "warn"}>
          geoblock: {geo.status}
          {geo.country ? ` (${geo.country})` : ""}
        </Badge>
      ) : null}
      <span className="text-muted">
        Order submission is intentionally disabled in this MVP — preview only (A-021 signing spike
        is open).
      </span>
    </div>
  );
}
