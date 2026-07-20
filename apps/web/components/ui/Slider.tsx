"use client";

/**
 * Dependency-free range slider: a styled native `<input type="range">` so
 * keyboard (arrows/Home/End), touch, focus and a11y come for free — only the
 * track/thumb are restyled (see `.slider-arima` in globals.css). The filled
 * portion is a brand-colored gradient driven by the current value.
 */
import { cn } from "@/components/ui";

export function Slider({
  value,
  onChange,
  min = 0,
  max,
  step,
  disabled = false,
  ariaLabel,
  valueText,
  className,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max: number;
  /** Omit for continuous (`any`) dragging; the caller rounds the result. */
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
  /** Human-readable value for screen readers, e.g. "$12.50". */
  valueText?: string;
  className?: string;
}) {
  const span = max > min ? max - min : 1;
  const current = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
  const pct = Math.max(0, Math.min(100, ((current - min) / span) * 100));
  return (
    <input
      type="range"
      className={cn("slider-arima", className)}
      min={min}
      max={max}
      step={step ?? "any"}
      value={current}
      disabled={disabled || max <= min}
      aria-label={ariaLabel}
      aria-valuetext={valueText}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        background: `linear-gradient(to right, var(--brand) 0%, var(--brand) ${pct}%, var(--surface-3) ${pct}%, var(--surface-3) 100%)`,
      }}
    />
  );
}
