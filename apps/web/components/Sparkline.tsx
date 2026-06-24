// Hand-rolled inline SVG sparkline — no charting dependency (per slice decision).
// Renders a 0–1 series (e.g. Polymarket probability over time).

export function Sparkline({
  values,
  width = 560,
  height = 120,
  stroke = "var(--accent)",
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
}) {
  if (values.length < 2) {
    return <div className="text-sm text-muted">Not enough data to chart.</div>;
  }

  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);

  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });

  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1]!;
  const first = values[0]!;
  const latest = values[values.length - 1]!;
  const up = latest >= first;
  const color = stroke ?? (up ? "var(--pos)" : "var(--neg)");

  const area = `${line} L${last[0].toFixed(1)},${height - pad} L${pad},${height - pad} Z`;

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="price history">
      <path d={area} fill={up ? "var(--pos)" : "var(--neg)"} opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}
