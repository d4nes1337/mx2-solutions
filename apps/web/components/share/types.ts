// ─────────────────────────────────────────────────────────────────────────────
// Flex-card data contract.
//
// This is the SINGLE source of truth for what a shareable card can display. App
// code only ever produces a `FlexCardModel`; templates only ever consume one.
// A designer can add new templates (see AUTHORING.md) without app code changing,
// because everything routes through this contract.
// ─────────────────────────────────────────────────────────────────────────────

export type FlexCardKind = "position-pnl" | "portfolio-summary" | "market-bet";
export type FlexTone = "pos" | "neg";
export type FlexAspect = "social" | "square";

export interface FlexCardModel {
  kind: FlexCardKind;

  /** Branding / identity. PII is opt-in — omit for an anonymous card. */
  handle?: string;
  /** Prefer a data-URL so PNG export stays un-tainted (see AUTHORING.md). */
  avatarUrl?: string;
  brandLabel?: string; // defaults to "arima"

  /** Headline. */
  title: string; // market question, or "My Portfolio"
  subtitle?: string;
  outcome?: string; // "Yes" / "No" / outcome label

  /** The money. */
  tone: FlexTone;
  pnlUsd?: number;
  pnlPct?: number;

  /** Trade context (all optional; prices are 0–1 probabilities). */
  entryPrice?: number;
  markPrice?: number;
  size?: number;
  timeframe?: string; // "7d", "since entry", …

  /** Visuals. */
  sparkline?: number[];

  /** Template routing + freeform slots for designer templates. */
  templateId?: string;
  theme?: string;
  extra?: Record<string, string | number | undefined>;

  generatedAt: number; // unix ms
}

export interface FlexTemplateMeta {
  id: string;
  label: string;
  aspect: FlexAspect;
  width: number;
  height: number;
}

/** A representative model for previews, tests, and template authoring. */
export function sampleFlexModel(overrides: Partial<FlexCardModel> = {}): FlexCardModel {
  return {
    kind: "position-pnl",
    handle: "satoshi",
    brandLabel: "arima",
    title: "Will France win the 2026 World Cup?",
    outcome: "Yes",
    tone: "pos",
    pnlUsd: 342.18,
    pnlPct: 142.8,
    entryPrice: 0.32,
    markPrice: 0.78,
    size: 200,
    timeframe: "since entry",
    sparkline: [0.32, 0.35, 0.34, 0.41, 0.47, 0.52, 0.61, 0.68, 0.72, 0.78],
    generatedAt: Date.now(),
    ...overrides,
  };
}
