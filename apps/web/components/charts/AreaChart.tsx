"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface ChartPoint {
  t: number; // unix seconds or ms
  v: number;
}

/**
 * Interactive area/line chart — dependency-free SVG with crosshair + tooltip.
 * The container width is measured (ResizeObserver) and the SVG is drawn at real
 * pixels (1:1), so axis text stays crisp and the crosshair maps exactly to the
 * pointer at any width.
 */
export function AreaChart({
  data,
  height = 260,
  color,
  valueFormat = (v) => v.toFixed(2),
  timeFormat = defaultTimeFormat,
  yTicks = 4,
  showAxis = true,
  fill = true,
  className,
}: {
  data: ChartPoint[];
  height?: number;
  /** Override trend colour; defaults to green/red by net direction. */
  color?: string;
  valueFormat?: (v: number) => string;
  timeFormat?: (t: number, withTime?: boolean) => string;
  yTicks?: number;
  showAxis?: boolean;
  fill?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const padT = 14;
  const padB = showAxis ? 22 : 8;
  const padL = 10;
  const padR = showAxis ? 54 : 10;

  const geom = useMemo(() => {
    if (data.length < 2) return null;
    const values = data.map((d) => d.v);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 0.5;
      max += 0.5;
    }
    const head = (max - min) * 0.08;
    min -= head;
    max += head;
    const span = max - min;

    const innerW = w - padL - padR;
    const innerH = H - padT - padB;
    const x = (i: number) => padL + (i / (data.length - 1)) * innerW;
    const y = (v: number) => padT + (1 - (v - min) / span) * innerH;

    const pts = data.map((d, i) => [x(i), y(d.v)] as const);
    const line = pts
      .map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`)
      .join(" ");
    const area = `${line} L${x(data.length - 1).toFixed(2)},${(H - padB).toFixed(2)} L${padL.toFixed(2)},${(H - padB).toFixed(2)} Z`;

    return { min, max, span, x, y, pts, line, area };
  }, [data, w, H, padB, padR]);

  if (!geom) {
    return (
      <div ref={wrapRef} className={className} style={{ height }}>
        <div className="flex h-full items-center justify-center text-xs text-muted">
          Not enough data to chart.
        </div>
      </div>
    );
  }

  const first = data[0]!.v;
  const last = data[data.length - 1]!.v;
  const up = last >= first;
  const stroke = color ?? (up ? "var(--pos)" : "var(--neg)");
  const lastPt = geom.pts[geom.pts.length - 1]!;

  const hover = hoverIdx != null ? data[hoverIdx] : null;
  const hoverPt = hoverIdx != null ? geom.pts[hoverIdx] : null;

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = geom.max - (geom.span * i) / yTicks;
    return { y: geom.y(v), v };
  });

  const handleMove = (clientX: number, rect: DOMRect) => {
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHoverIdx(Math.round(frac * (data.length - 1)));
  };

  return (
    <div ref={wrapRef} className={className} style={{ position: "relative", height }}>
      <svg width={w} height={H} role="img" aria-label="price chart" style={{ display: "block" }}>
        <defs>
          <linearGradient id={`grad-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>

        {showAxis &&
          ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={padL}
                x2={w - padR}
                y1={t.y}
                y2={t.y}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray={i === 0 || i === ticks.length - 1 ? undefined : "2 4"}
                opacity={0.7}
              />
              <text
                x={w - padR + 6}
                y={t.y + 3}
                fill="var(--muted)"
                fontSize={11}
                fontFamily="var(--font-mono)"
              >
                {valueFormat(t.v)}
              </text>
            </g>
          ))}

        {fill ? <path d={geom.area} fill={`url(#grad-${uid})`} /> : null}
        <path
          d={geom.line}
          fill="none"
          stroke={stroke}
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* last point + pulse */}
        <circle cx={lastPt[0]} cy={lastPt[1]} r={3} fill={stroke} />
        <circle cx={lastPt[0]} cy={lastPt[1]} r={5} fill={stroke} opacity={0.2}>
          <animate attributeName="r" values="4;9;4" dur="2.2s" repeatCount="indefinite" />
          <animate
            attributeName="opacity"
            values="0.28;0;0.28"
            dur="2.2s"
            repeatCount="indefinite"
          />
        </circle>

        {hoverPt ? (
          <>
            <line
              x1={hoverPt[0]}
              x2={hoverPt[0]}
              y1={padT}
              y2={H - padB}
              stroke="var(--border-strong)"
              strokeWidth={1}
            />
            <circle
              cx={hoverPt[0]}
              cy={hoverPt[1]}
              r={3.5}
              fill={stroke}
              stroke="var(--bg)"
              strokeWidth={1.5}
            />
          </>
        ) : null}

        {showAxis ? (
          <>
            <text
              x={padL}
              y={H - 6}
              fill="var(--muted)"
              fontSize={11}
              fontFamily="var(--font-mono)"
            >
              {timeFormat(data[0]!.t)}
            </text>
            <text
              x={w - padR}
              y={H - 6}
              textAnchor="end"
              fill="var(--muted)"
              fontSize={11}
              fontFamily="var(--font-mono)"
            >
              {timeFormat(data[data.length - 1]!.t)}
            </text>
          </>
        ) : null}

        <rect
          x={0}
          y={0}
          width={w}
          height={H}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onPointerMove={(e) => handleMove(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setHoverIdx(null)}
        />
      </svg>

      {hover && hoverPt ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-border-strong bg-surface-3/95 px-2 py-1 text-center shadow-pop backdrop-blur"
          style={{ left: Math.min(w - 48, Math.max(48, hoverPt[0])), top: 2 }}
        >
          <div className="tabular text-xs font-semibold text-fg">{valueFormat(hover.v)}</div>
          <div className="tabular text-[10px] text-muted">{timeFormat(hover.t, true)}</div>
        </div>
      ) : null}
    </div>
  );
}

function defaultTimeFormat(t: number, withTime = false): string {
  const ms = t < 1e12 ? t * 1000 : t;
  const d = new Date(ms);
  if (withTime) {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
