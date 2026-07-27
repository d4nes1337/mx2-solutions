"use client";

/**
 * Preset-plus-custom duration control. Presets cover the common choices in one
 * tap; "Custom" reveals a number + unit pair so any value in range is
 * reachable — the conventional pattern (Grafana time ranges, Linear snooze):
 * never trap the user inside a fixed menu.
 *
 * A stored value that matches no preset selects Custom automatically and shows
 * itself in the largest unit that divides it evenly, so reopening an edited
 * strategy never silently snaps the value onto a neighbouring preset.
 */
import { useEffect, useState } from "react";
import { cn } from "@/components/ui";

export type DurationUnit = "seconds" | "minutes" | "hours" | "days";

const UNIT_MS: Record<DurationUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const UNIT_LABEL: Record<DurationUnit, string> = {
  seconds: "sec",
  minutes: "min",
  hours: "hours",
  days: "days",
};

/** Largest unit that divides `ms` evenly — how a custom value reads back. */
export const splitDuration = (
  ms: number,
  allowed: DurationUnit[],
): { amount: number; unit: DurationUnit } => {
  const order: DurationUnit[] = ["days", "hours", "minutes", "seconds"];
  for (const unit of order) {
    if (!allowed.includes(unit)) continue;
    const size = UNIT_MS[unit];
    if (ms >= size && ms % size === 0) return { amount: ms / size, unit };
  }
  const fallback = allowed[allowed.length - 1] ?? "minutes";
  return { amount: Math.max(0, Math.round(ms / UNIT_MS[fallback])), unit: fallback };
};

export function DurationField({
  value,
  onChange,
  presets,
  units = ["minutes", "hours", "days"],
  min = 0,
  max = 365 * 86_400_000,
  /** Rendered as an extra leading preset (e.g. "never" → null-ish 0). */
  className,
}: {
  /** Current duration in milliseconds. */
  value: number;
  onChange: (ms: number) => void;
  presets: { value: number; label: string }[];
  units?: DurationUnit[];
  min?: number;
  max?: number;
  className?: string;
}) {
  const matchesPreset = presets.some((p) => p.value === value);
  const [custom, setCustom] = useState(!matchesPreset);
  const initial = splitDuration(value, units);
  const [amount, setAmount] = useState<string>(String(initial.amount));
  const [unit, setUnit] = useState<DurationUnit>(initial.unit);

  // An external change (AI apply, draft load, template switch) re-syncs the
  // control: a value that stopped matching a preset flips it back to Custom.
  useEffect(() => {
    const isPreset = presets.some((p) => p.value === value);
    setCustom(!isPreset);
    if (!isPreset) {
      const next = splitDuration(value, units);
      setAmount(String(next.amount));
      setUnit(next.unit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (rawAmount: string, nextUnit: DurationUnit) => {
    const n = Number(rawAmount);
    if (!Number.isFinite(n)) return;
    const ms = Math.round(n * UNIT_MS[nextUnit]);
    onChange(Math.min(max, Math.max(min, ms)));
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="nodrag flex flex-wrap gap-1 rounded-md border border-border bg-surface-2 p-0.5">
        {presets.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => {
              setCustom(false);
              onChange(p.value);
            }}
            className={cn(
              "rounded-[3px] px-2.5 py-1 text-xs font-medium transition-colors",
              !custom && value === p.value
                ? "bg-brand text-white shadow-[0_0_14px_-6px_rgba(var(--brand-rgb),0.45)]"
                : "text-muted hover:text-fg",
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setCustom(true);
            commit(amount, unit);
          }}
          className={cn(
            "rounded-[3px] px-2.5 py-1 text-xs font-medium transition-colors",
            custom
              ? "bg-brand text-white shadow-[0_0_14px_-6px_rgba(var(--brand-rgb),0.45)]"
              : "text-muted hover:text-fg",
          )}
        >
          Custom
        </button>
      </div>

      {custom ? (
        <div className="nodrag flex items-center gap-1.5">
          <input
            type="number"
            inputMode="numeric"
            value={amount}
            min={0}
            onChange={(e) => {
              setAmount(e.target.value);
              commit(e.target.value, unit);
            }}
            aria-label="Custom duration amount"
            className="tabular w-20 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-brand"
          />
          <select
            value={unit}
            onChange={(e) => {
              const next = e.target.value as DurationUnit;
              setUnit(next);
              commit(amount, next);
            }}
            aria-label="Custom duration unit"
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-fg outline-none focus:border-brand"
          >
            {units.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
