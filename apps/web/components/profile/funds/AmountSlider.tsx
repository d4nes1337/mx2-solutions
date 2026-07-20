"use client";

/**
 * Amount control with a draggable slider (0 → available balance) plus precise
 * numeric entry — the deposit/withdraw "how much" input. Supersedes the
 * percent-button `AmountPresets` at the main funding call sites; when the
 * available balance is unknown it degrades to input-only. Shows a live USD
 * readout when a per-unit price is known so volatile assets read like dollars.
 */
import { cn } from "@/components/ui";
import { Slider } from "@/components/ui/Slider";
import { floorTo } from "./AmountPresets";

export function AmountSlider({
  value,
  onChange,
  maxAmount,
  decimals = 2,
  unitLabel = "",
  usdPerUnit = null,
  minUsd = null,
  disabled = false,
  placeholder,
}: {
  /** Raw input string, owned by the parent form. */
  value: string;
  onChange: (next: string) => void;
  /** Available balance the slider spans; null/0 → input-only (no slider). */
  maxAmount: number | null;
  /** Rounding for slider/Max values (2 for USD, more for volatile amounts). */
  decimals?: number;
  unitLabel?: string;
  /** USD per unit for the live "≈ $…" readout; null hides it. */
  usdPerUnit?: number | null;
  /** Route minimum (USD) shown as a hint under the slider. */
  minUsd?: number | null;
  disabled?: boolean;
  placeholder?: string;
}) {
  const amount = Number(value);
  const hasAmount = value !== "" && Number.isFinite(amount) && amount > 0;
  const max = maxAmount != null && maxAmount > 0 ? maxAmount : null;
  const usd = usdPerUnit != null && hasAmount ? amount * usdPerUnit : null;
  const maxLabel = max != null ? String(floorTo(max, decimals)) : null;
  const unit = unitLabel ? ` ${unitLabel}` : "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? (maxLabel != null ? `Amount (max ${maxLabel}${unit})` : "Amount")}
          min="0"
          step="any"
          disabled={disabled}
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none disabled:opacity-50"
        />
        {usd != null ? (
          <span className="tabular shrink-0 text-[12px] text-muted">≈ ${usd.toFixed(2)}</span>
        ) : null}
      </div>

      {max != null ? (
        <>
          <Slider
            value={hasAmount ? amount : 0}
            onChange={(n) => onChange(String(floorTo(n, decimals)))}
            max={max}
            disabled={disabled}
            ariaLabel={`Amount${unit}`}
            valueText={usd != null ? `$${usd.toFixed(2)}` : `${floorTo(hasAmount ? amount : 0, decimals)}${unit}`}
          />
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span>{minUsd != null ? `min $${minUsd}` : " "}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(String(floorTo(max, decimals)))}
              className={cn(
                "tabular font-medium text-accent hover:underline disabled:opacity-50",
              )}
            >
              Max {maxLabel}
              {unit}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
