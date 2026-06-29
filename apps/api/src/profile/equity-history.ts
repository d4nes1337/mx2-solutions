import type { Activity, Position } from "@mx2/polymarket-client";

export type EquityWindow = "7d" | "30d" | "all";

export interface EquityPoint {
  t: number;
  equity: number;
}

export const EQUITY_DISCLAIMER =
  "Approximate equity curve derived from trade activity USDC flows plus current open-position value. " +
  "Not accounting-grade; redeems, splits, merges, and transfers may be missing or mis-timed.";

export const EQUITY_METHODOLOGY =
  "Walk TRADE activity chronologically: BUY subtracts usdcSize, SELL adds usdcSize. " +
  "The final point anchors to current portfolio value from open positions.";

const windowStartSec = (window: EquityWindow, nowSec: number): number | null => {
  if (window === "all") return null;
  const days = window === "7d" ? 7 : 30;
  return nowSec - days * 86400;
};

/** Build approximate equity time series from activity + current positions. */
export const buildEquityHistory = (
  activity: Activity[],
  positions: Position[],
  window: EquityWindow,
): EquityPoint[] => {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = windowStartSec(window, nowSec);

  const portfolioValue = positions.reduce((sum, p) => sum + p.currentValue, 0);

  const trades = [...activity]
    .filter((a) => a.type === "TRADE" && a.side)
    .sort((a, b) => a.timestamp - b.timestamp);

  let cumulative = 0;
  const raw: EquityPoint[] = [];

  for (const a of trades) {
    const flow = a.side === "BUY" ? -a.usdcSize : a.usdcSize;
    cumulative += flow;
    raw.push({ t: a.timestamp, equity: cumulative });
  }

  // Anchor the latest point to today's portfolio value.
  const anchor: EquityPoint = { t: nowSec, equity: portfolioValue };
  if (raw.length === 0) {
    return startSec !== null ? [{ t: startSec, equity: portfolioValue }, anchor] : [anchor];
  }

  // Shift historical cumulative flows so the last pre-anchor point flows into portfolio value.
  const lastFlowEquity = raw[raw.length - 1]!.equity;
  const shift = portfolioValue - lastFlowEquity;
  const shifted = raw.map((p) => ({ t: p.t, equity: p.equity + shift }));

  const series = [...shifted, anchor];

  if (startSec === null) return series;
  return series.filter((p) => p.t >= startSec);
};
