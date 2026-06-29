"use client";

import { useId } from "react";

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
