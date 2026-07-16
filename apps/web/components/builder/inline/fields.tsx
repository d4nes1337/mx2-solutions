"use client";

/**
 * Shared field primitives for the inline node editors. Everything interactive
 * carries `nodrag` so React Flow never starts a node drag from a control.
 */
import type { MarketRef } from "@mx2/rules";
import { cn } from "@/components/ui";
import { isBound, marketLabel, type MarketMeta, type StrategyDoc } from "@/lib/smart-orders/doc";
import { MarketSearch } from "../MarketSearch";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  suffix,
  step = 1,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div
      className={cn(
        "nodrag flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5",
        "focus-within:border-brand",
      )}
    >
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="tabular w-full bg-transparent text-[13px] text-fg outline-none"
      />
      {suffix ? <span className="shrink-0 text-[11px] text-faint">{suffix}</span> : null}
    </div>
  );
}

/** Cents in the UI ↔ probability in the model. */
export const toCents = (p: number) => Math.round(p * 100);
export const fromCents = (c: number) => Math.min(0.99, Math.max(0.01, c / 100));

export function MarketBinding({
  current,
  doc,
  onPick,
}: {
  current: MarketRef;
  doc: StrategyDoc;
  onPick: (ref: MarketRef, meta: MarketMeta) => void;
}) {
  return (
    // `nowheel`: the results list scrolls; without it React Flow zooms instead.
    <div className="nodrag nowheel space-y-2">
      {isBound(current) ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5">
          <span className="truncate text-[12px] text-fg">{marketLabel(doc, current)}</span>
          <span className="shrink-0 rounded-full border border-brand/40 bg-brand-soft px-2 text-[10px] font-semibold text-accent">
            {current.outcome}
          </span>
        </div>
      ) : (
        <p className="text-[12px] font-medium text-warn">Pick a market for this block:</p>
      )}
      <MarketSearch onPick={onPick} autoFocus={!isBound(current)} />
    </div>
  );
}
