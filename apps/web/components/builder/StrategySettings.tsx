"use client";

/**
 * Strategy-wide settings (Settings tab): trigger logic, hold window,
 * recurrence and data-freshness. Per-block editing happens inline on the
 * canvas nodes.
 */
import { Segmented } from "@/components/ui";
import { useBuilderStore } from "@/lib/strategies/store";
import { Field } from "./editors/fields";
import { ExpiryField, RecurrenceFields } from "./editors/RecurrenceFields";
import { DurationField } from "./editors/DurationField";

const HOLD_PRESETS = [
  { value: 0, label: "instant" },
  { value: 60_000, label: "1m" },
  { value: 300_000, label: "5m" },
  { value: 600_000, label: "10m" },
  { value: 1_800_000, label: "30m" },
  { value: 3_600_000, label: "1h" },
];

const FRESH_PRESETS = [
  { value: 2_000, label: "2s" },
  { value: 5_000, label: "5s" },
  { value: 10_000, label: "10s" },
  { value: 30_000, label: "30s" },
];

/**
 * The fields alone — for hosts that already provide a titled frame (the
 * settings sheet). Rendering the boxed `StrategySettings` there produced a
 * card inside a card under a duplicated title.
 */
export function StrategySettingsFields() {
  const doc = useBuilderStore((s) => s.doc);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  const setHoldsFor = useBuilderStore((s) => s.setHoldsFor);
  const setMaxDataAge = useBuilderStore((s) => s.setMaxDataAge);

  return (
    <div className="space-y-3">
      <Field label="Trigger when">
        <Segmented
          options={[
            { value: "and", label: "ALL conditions hold" },
            { value: "or", label: "ANY condition holds" },
          ]}
          value={doc.expr.op === "or" ? "or" : "and"}
          onChange={(op) => setRootOp(op)}
          size="md"
          grow
        />
      </Field>
      <Field label="Conditions must hold for">
        <DurationField
          value={doc.holdsForMs}
          onChange={setHoldsFor}
          presets={HOLD_PRESETS}
          units={["seconds", "minutes", "hours"]}
          max={86_400_000}
        />
      </Field>
      <RecurrenceFields />
      <ExpiryField />
      <details className="rounded-lg border border-border bg-surface-2 px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-muted">Advanced</summary>
        <div className="mt-2 space-y-2">
          <Field label="Market data freshness">
            <DurationField
              value={doc.maxDataAgeMs}
              onChange={setMaxDataAge}
              presets={FRESH_PRESETS}
              units={["seconds", "minutes"]}
              min={1_000}
              max={600_000}
            />
          </Field>
          <p className="text-[11px] leading-snug text-muted">
            If live data is older than this, the strategy pauses its countdown and can never trigger
            on stale information.
          </p>
        </div>
      </details>
    </div>
  );
}

/** Boxed variant with its own title — the canvas workspace Settings tab. */
export function StrategySettings() {
  return (
    <aside className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel">
      <h3 className="text-[13px] font-semibold text-fg">Strategy settings</h3>
      <StrategySettingsFields />
    </aside>
  );
}
