import type { ClosedPosition } from "@mx2/polymarket-client";

export type EquityWindow = "7d" | "30d" | "all";

export interface EquityPoint {
  t: number;
  pnl: number;
}

export const EQUITY_DISCLAIMER =
  "Approximate PnL curve derived from Polymarket closed-position realized PnL and anchored to the " +
  "current account-level leaderboard PnL. Older positions outside the fetched window are compressed " +
  "into the opening baseline.";

export const EQUITY_METHODOLOGY =
  "Walk closed positions chronologically by timestamp, add realizedPnl, and anchor the latest point " +
  "to Polymarket Data API /v1/leaderboard timePeriod=ALL pnl.";

const windowStartSec = (window: EquityWindow, nowSec: number): number | null => {
  if (window === "all") return null;
  const days = window === "7d" ? 7 : 30;
  return nowSec - days * 86400;
};

/** Build approximate PnL time series from closed positions + current account PnL. */
export const buildEquityHistory = (
  closedPositions: ClosedPosition[],
  currentAccountPnl: number,
  window: EquityWindow,
): EquityPoint[] => {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = windowStartSec(window, nowSec);

  const closed = [...closedPositions]
    .filter((p) => startSec === null || p.timestamp >= startSec)
    .sort((a, b) => a.timestamp - b.timestamp);

  const realizedInWindow = closed.reduce((sum, p) => sum + p.realizedPnl, 0);
  const baseline = currentAccountPnl - realizedInWindow;
  const points: EquityPoint[] =
    startSec !== null
      ? [{ t: startSec, pnl: baseline }]
      : closed[0]
        ? [{ t: Math.max(0, closed[0].timestamp - 1), pnl: baseline }]
        : [];

  let cumulative = baseline;
  for (const p of closed) {
    cumulative += p.realizedPnl;
    points.push({ t: p.timestamp, pnl: cumulative });
  }

  const last = points[points.length - 1];
  if (!last || last.t !== nowSec || Math.abs(last.pnl - currentAccountPnl) > 0.0001) {
    points.push({ t: nowSec, pnl: currentAccountPnl });
  }
  return points;
};
