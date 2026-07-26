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

const HOLD_OPTIONS = [
  { value: "0", label: "instant" },
  { value: "60000", label: "1m" },
  { value: "300000", label: "5m" },
  { value: "600000", label: "10m" },
  { value: "1800000", label: "30m" },
  { value: "3600000", label: "1h" },
];

const FRESH_OPTIONS = [
  { value: "2000", label: "2s" },
  { value: "5000", label: "5s" },
  { value: "10000", label: "10s" },
  { value: "30000", label: "30s" },
];

export function StrategySettings() {
  const doc = useBuilderStore((s) => s.doc);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  const setHoldsFor = useBuilderStore((s) => s.setHoldsFor);
  const setMaxDataAge = useBuilderStore((s) => s.setMaxDataAge);

  return (
    <aside className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel">
      <h3 className="text-[13px] font-semibold text-fg">Strategy settings</h3>
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
        <Segmented
          options={HOLD_OPTIONS}
          value={String(doc.holdsForMs)}
          onChange={(v) => setHoldsFor(Number(v))}
          size="md"
          grow={3}
        />
      </Field>
      <RecurrenceFields />
      <ExpiryField />
      <details className="rounded-lg border border-border bg-surface-2 px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-muted">Advanced</summary>
        <div className="mt-2 space-y-2">
          <Field label="Market data freshness">
            <Segmented
              options={FRESH_OPTIONS}
              value={String(doc.maxDataAgeMs)}
              onChange={(v) => setMaxDataAge(Number(v))}
              size="md"
              grow
            />
          </Field>
          <p className="text-[11px] leading-snug text-muted">
            If live data is older than this, the strategy pauses its countdown and can never trigger
            on stale information.
          </p>
        </div>
      </details>
    </aside>
  );
}
