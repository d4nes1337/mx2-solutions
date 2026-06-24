// Small display helpers. JSON-string arrays come straight from the Gamma API.

export function parseJsonArray(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

export function shortAddress(addr: string | undefined | null): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function toNum(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function usd(v: string | number | undefined | null): string {
  const n = toNum(v);
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact USD for dense feed rows ($1.2k, $3.4M). */
export function usdCompact(v: string | number | undefined | null): string {
  const n = toNum(v);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (abs >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

// A 0–1 probability rendered as a percent (Polymarket prices are probabilities).
export function pct(v: string | number | undefined | null): string {
  const n = toNum(v);
  return `${(n * 100).toFixed(1)}%`;
}

export function signed(v: string | number | undefined | null): string {
  const n = toNum(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function timeAgo(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
