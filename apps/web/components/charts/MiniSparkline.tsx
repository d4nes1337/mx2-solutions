"use client";

import { useId } from "react";
import { cn } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";

/**
 * Compact trend sparkline — no axes, no interaction. For table cells, hover
 * previews, and inline price movement. Colours by net direction unless `stroke`
 * is given.
 */
export function MiniSparkline({
  values,
  width = 120,
  height = 32,
  stroke,
  fill = true,
  strokeWidth = 1.5,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: boolean;
  strokeWidth?: number;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  if (values.length < 2) {
    return <div className={className} style={{ width, height }} />;
  }

  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);

  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });

  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const last = pts[pts.length - 1]!;
  const up = values[values.length - 1]! >= values[0]!;
  const color = stroke ?? (up ? "var(--pos)" : "var(--neg)");
  const area = `${line} L${last[0].toFixed(1)},${height - pad} L${pad},${height - pad} Z`;

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="trend"
    >
      <defs>
        <linearGradient id={`mini-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#mini-${uid})`} /> : null}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r={1.8} fill={color} />
    </svg>
  );
}

/**
 * Sparkline with a glowing, pulsing leading dot — for live feeds and the movers
 * strip. The pulse is an HTML overlay (not an SVG node) so it stays circular even
 * when the sparkline is stretched with preserveAspectRatio="none".
 */
export function LiveSparkline({
  values,
  height = 32,
  stroke,
  className,
  ...rest
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: boolean;
  strokeWidth?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const up = values.length >= 2 ? values[values.length - 1]! >= values[0]! : true;
  const color = stroke ?? (up ? "var(--pos)" : "var(--neg)");

  // Match MiniSparkline's vertical mapping (pad=2) so the dot lands on the line.
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const lastV = values[values.length - 1] ?? min;
  const topFrac = (pad + (height - pad * 2) * (1 - (lastV - min) / range)) / height;

  return (
    <div className={cn("relative", className)}>
      <MiniSparkline
        values={values}
        height={height}
        stroke={stroke}
        className="h-full w-full"
        {...rest}
      />
      {!reduced && values.length >= 2 ? (
        <span
          className="pulse-dot absolute h-1.5 w-1.5 -translate-y-1/2 rounded-full"
          style={{
            right: 1,
            top: `${topFrac * 100}%`,
            background: color,
            boxShadow: `0 0 6px ${color}`,
          }}
        />
      ) : null}
    </div>
  );
}
