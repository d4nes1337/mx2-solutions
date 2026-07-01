// Build FlexCardModels from app data. App code produces models; templates render
// them (see AUTHORING.md). No wallet addresses / PII are included by default.

import type { MarketPnlItem, PnlSummary, PortfolioProfile, Position } from "@/lib/types";
import { toNum } from "@/lib/format";
import type { FlexCardModel } from "./types";

export function flexModelFromPosition(p: Position): FlexCardModel {
  const pnlUsd = toNum(p.cashPnl);
  return {
    kind: "position-pnl",
    title: p.title ?? "Prediction position",
    outcome: p.outcome,
    tone: pnlUsd >= 0 ? "pos" : "neg",
    pnlUsd,
    pnlPct: toNum(p.percentPnl),
    entryPrice: toNum(p.avgPrice),
    markPrice: p.curPrice != null ? toNum(p.curPrice) : undefined,
    size: toNum(p.size),
    timeframe: "since entry",
    generatedAt: Date.now(),
  };
}

export function flexModelFromMarketPnl(
  item: MarketPnlItem,
  profile?: PortfolioProfile | null,
): FlexCardModel {
  const pnlUsd = toNum(item.pnl);
  return {
    kind: "market-bet",
    title: item.title ?? "Prediction market",
    outcome: item.outcome,
    tone: pnlUsd >= 0 ? "pos" : "neg",
    pnlUsd,
    pnlPct: item.pnlPct ?? undefined,
    entryPrice: toNum(item.avgPrice),
    markPrice: item.curPrice != null ? toNum(item.curPrice) : undefined,
    size: item.size ?? undefined,
    timeframe: item.statusLabel,
    handle: profile?.name ?? profile?.xUsername ?? undefined,
    avatarUrl: profile?.profileImage ?? undefined,
    generatedAt: Date.now(),
  };
}

export function flexModelFromPortfolio(
  summary: PnlSummary,
  opts?: { handle?: string; avatarUrl?: string | null },
): FlexCardModel {
  const pnlUsd = toNum(summary.totalPnl);
  const equity = toNum(summary.currentPortfolioValue);
  const cost = equity - pnlUsd;
  return {
    kind: "portfolio-summary",
    title: "My arima portfolio",
    tone: pnlUsd >= 0 ? "pos" : "neg",
    pnlUsd,
    pnlPct: cost > 0 ? (pnlUsd / cost) * 100 : 0,
    timeframe: `${summary.openPositions} position${summary.openPositions === 1 ? "" : "s"}`,
    handle: opts?.handle,
    avatarUrl: opts?.avatarUrl ?? undefined,
    generatedAt: Date.now(),
  };
}
