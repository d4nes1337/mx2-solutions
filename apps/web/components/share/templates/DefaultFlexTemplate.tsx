// Default flex-card template — a clean, on-brand card shipped now so the feature
// works end-to-end. A designer replaces/extends this via the registry.
//
// IMPORTANT: templates use LITERAL hex colours, not CSS `var(--…)` tokens. The
// card is serialized and rasterized standalone (see export.ts), where document
// CSS variables and web fonts are unavailable — literal values + system fonts
// keep the PNG faithful. Keep external <image> refs as data-URLs, or omit them.

import type { FlexCardModel } from "../types";

const C = {
  bg: "#06070d",
  panel: "#0b0d15",
  border: "#1d2130",
  fg: "#e9ecf5",
  muted: "#8a93ab",
  faint: "#59617a",
  brand: "#2a36ff",
  accent: "#7c84ff",
  pos: "#2bd98c",
  neg: "#ff4d5e",
} as const;

const SANS = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const DEFAULT_FLEX_SIZE = { width: 1200, height: 675 } as const;

export function DefaultFlexTemplate({ model }: { model: FlexCardModel }) {
  const { width: W, height: H } = DEFAULT_FLEX_SIZE;
  const toneColor = model.tone === "pos" ? C.pos : C.neg;
  const brand = model.brandLabel ?? "arima";

  const pctStr =
    model.pnlPct != null ? `${model.pnlPct >= 0 ? "+" : ""}${model.pnlPct.toFixed(1)}%` : "";
  const usdStr =
    model.pnlUsd != null
      ? `${model.pnlUsd >= 0 ? "+$" : "-$"}${Math.abs(model.pnlUsd).toFixed(2)}`
      : "";

  const titleLines = wrapByChars(model.title, 30).slice(0, 2);
  const contextBits = [
    model.entryPrice != null
      ? `${cents(model.entryPrice)} → ${cents(model.markPrice ?? model.entryPrice)}`
      : "",
    model.size != null ? `${formatNum(model.size)} sh` : "",
    model.timeframe,
  ].filter(Boolean);

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Shareable PnL card"
    >
      <defs>
        <radialGradient id="flex-glow" cx="14%" cy="0%" r="70%">
          <stop offset="0%" stopColor={C.brand} stopOpacity={0.28} />
          <stop offset="60%" stopColor={C.brand} stopOpacity={0} />
        </radialGradient>
        <radialGradient id="flex-tone" cx="86%" cy="100%" r="60%">
          <stop offset="0%" stopColor={toneColor} stopOpacity={0.16} />
          <stop offset="70%" stopColor={toneColor} stopOpacity={0} />
        </radialGradient>
        <linearGradient id="flex-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={toneColor} stopOpacity={0.35} />
          <stop offset="100%" stopColor={toneColor} stopOpacity={0} />
        </linearGradient>
        <clipPath id="flex-avatar">
          <rect x={64} y={H - 84} width={44} height={44} rx={10} />
        </clipPath>
      </defs>

      {/* Background */}
      <rect x={0} y={0} width={W} height={H} fill={C.bg} />
      <rect x={0} y={0} width={W} height={H} fill="url(#flex-glow)" />
      <rect x={0} y={0} width={W} height={H} fill="url(#flex-tone)" />
      <rect
        x={1}
        y={1}
        width={W - 2}
        height={H - 2}
        fill="none"
        stroke={C.border}
        strokeWidth={2}
        rx={16}
      />

      {/* Brand row */}
      <g transform="translate(64, 74)">
        <rect x={0} y={-22} width={30} height={30} rx={7} fill={C.brand} />
        <text
          x={42}
          y={2}
          fontFamily={SANS}
          fontSize={30}
          fontWeight={800}
          fill={C.fg}
          letterSpacing="-0.5"
        >
          {brand}
        </text>
      </g>
      {model.timeframe ? (
        <text x={W - 64} y={76} textAnchor="end" fontFamily={MONO} fontSize={22} fill={C.faint}>
          {model.timeframe}
        </text>
      ) : null}

      {/* Outcome + title */}
      {model.outcome ? (
        <g transform="translate(64, 150)">
          <rect
            x={0}
            y={-30}
            width={outcomePillWidth(model.outcome)}
            height={40}
            rx={8}
            fill={hexWithAlpha(toneColor, 0.14)}
            stroke={hexWithAlpha(toneColor, 0.5)}
            strokeWidth={1.5}
          />
          <text x={16} y={-2} fontFamily={SANS} fontSize={22} fontWeight={700} fill={toneColor}>
            {model.outcome.toUpperCase()}
          </text>
        </g>
      ) : null}
      <text
        x={64}
        y={model.outcome ? 214 : 190}
        fontFamily={SANS}
        fontSize={44}
        fontWeight={700}
        fill={C.fg}
      >
        {titleLines.map((line, i) => (
          <tspan key={i} x={64} dy={i === 0 ? 0 : 52}>
            {line}
          </tspan>
        ))}
      </text>

      {/* Hero PnL */}
      <text
        x={64}
        y={500}
        fontFamily={MONO}
        fontSize={132}
        fontWeight={800}
        fill={toneColor}
        letterSpacing="-2"
      >
        {pctStr}
      </text>
      <text
        x={68}
        y={556}
        fontFamily={MONO}
        fontSize={40}
        fontWeight={700}
        fill={toneColor}
        opacity={0.9}
      >
        {usdStr}
      </text>

      {/* Trade context */}
      {contextBits.length ? (
        <text x={68} y={606} fontFamily={MONO} fontSize={24} fill={C.muted}>
          {contextBits.join("   ·   ")}
        </text>
      ) : null}

      {/* Sparkline */}
      {model.sparkline && model.sparkline.length >= 2 ? (
        <g transform={`translate(${W - 420}, 380)`}>
          <path d={sparkAreaPath(model.sparkline, 0, 0, 356, 150)} fill="url(#flex-spark)" />
          <path
            d={sparkLinePath(model.sparkline, 0, 0, 356, 150)}
            fill="none"
            stroke={toneColor}
            strokeWidth={4}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </g>
      ) : null}

      {/* Footer */}
      {model.avatarUrl ? (
        <image
          href={model.avatarUrl}
          x={64}
          y={H - 84}
          width={44}
          height={44}
          preserveAspectRatio="xMidYMid slice"
          clipPath="url(#flex-avatar)"
        />
      ) : null}
      <text
        x={model.avatarUrl ? 122 : 64}
        y={H - 52}
        fontFamily={SANS}
        fontSize={22}
        fill={C.faint}
      >
        {model.handle ? `@${model.handle}` : ""}
      </text>
      <text x={W - 64} y={H - 40} textAnchor="end" fontFamily={SANS} fontSize={22} fill={C.faint}>
        {brand}.trade
      </text>
    </svg>
  );
}

// ── local formatting/geometry helpers (kept literal for export fidelity) ─────

function cents(v: number): string {
  return `${(v * 100).toFixed(0)}¢`;
}
function formatNum(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function outcomePillWidth(label: string): number {
  return 32 + label.length * 14;
}
function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}
function wrapByChars(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if ((line + " " + w).length <= maxChars) line += " " + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function sparkPoints(values: number[], x: number, y: number, w: number, h: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  return values.map((v, i) => [x + i * stepX, y + h * (1 - (v - min) / range)] as const);
}
function sparkLinePath(values: number[], x: number, y: number, w: number, h: number): string {
  return sparkPoints(values, x, y, w, h)
    .map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
}
function sparkAreaPath(values: number[], x: number, y: number, w: number, h: number): string {
  const pts = sparkPoints(values, x, y, w, h);
  const line = pts
    .map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
  const lastX = pts[pts.length - 1]![0];
  return `${line} L${lastX.toFixed(1)},${(y + h).toFixed(1)} L${x.toFixed(1)},${(y + h).toFixed(1)} Z`;
}
