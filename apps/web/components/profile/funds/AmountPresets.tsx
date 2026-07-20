"use client";

/**
 * Shared amount input with percent presets (owner request): 25 / 50 / 75 /
 * Max of the available balance, plus free manual entry. One component owns
 * the rounding (2-decimal floor, matching the old Max buttons) so deposit and
 * withdraw can never disagree about what "Max" means.
 */
import { cn } from "@/components/ui";

const PRESETS = [
  { pct: 0.25, label: "25%" },
  { pct: 0.5, label: "50%" },
  { pct: 0.75, label: "75%" },
  { pct: 1, label: "Max" },
] as const;

/** Decimal floor — never suggest more than is actually available. */
export const floorTo = (value: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.floor(value * f) / f;
};

/** 2-decimal floor (USD) — matches the pre-existing Max button semantics. */
export const floorUsd = (value: number): number => floorTo(value, 2);

export function AmountPresets({
  value,
  onChange,
  max,
  decimals = 2,
  placeholder,
  disabled = false,
}: {
  /** Raw input string (owned by the parent form). */
  value: string;
  onChange: (next: string) => void;
  /** Available balance the percents apply to; null = unknown (presets hidden). */
  max: number | null;
  /** Rounding for preset values (2 for USD; more for volatile-asset amounts). */
  decimals?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const presetValue = (pct: number): string => String(floorTo((max ?? 0) * pct, decimals));
  const activePct =
    max !== null && value !== ""
      ? (PRESETS.find((p) => presetValue(p.pct) === value)?.pct ?? null)
      : null;
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? (max !== null ? `Amount (max $${max.toFixed(2)})` : "Amount (USD)")}
          min="0"
          step="1"
          disabled={disabled}
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none disabled:opacity-50"
        />
      </div>
      {max !== null && max > 0 ? (
        <div className="grid grid-cols-4 gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => onChange(presetValue(p.pct))}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                activePct === p.pct
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-fg",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
