"use client";

/**
 * Right-hand inspector: parameter editor for whatever is selected on the
 * canvas (condition, logic group, action) or the strategy itself. This is the
 * only place raw numbers are edited — nodes stay compact and readable.
 */
import { Trash2 } from "lucide-react";
import type { ConditionV2, MarketRef } from "@mx2/rules";
import { Button, Segmented, cn } from "@/components/ui";
import { findNode, isBound, marketLabel, UNBOUND, type StrategyDoc } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { MarketSearch } from "./MarketSearch";

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
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
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 focus-within:border-brand">
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
const toCents = (p: number) => Math.round(p * 100);
const fromCents = (c: number) => Math.min(0.99, Math.max(0.01, c / 100));

function MarketBinding({
  current,
  doc,
  onPick,
}: {
  current: MarketRef;
  doc: StrategyDoc;
  onPick: (ref: MarketRef, meta: { title: string }) => void;
}) {
  return (
    <div className="space-y-2">
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

function ConditionEditor({ id, condition }: { id: string; condition: ConditionV2 }) {
  const doc = useBuilderStore((s) => s.doc);
  const updateCondition = useBuilderStore((s) => s.updateCondition);
  const bindMarket = useBuilderStore((s) => s.bindMarket);
  const toggleNot = useBuilderStore((s) => s.toggleNot);
  const removeNode = useBuilderStore((s) => s.removeNode);
  const c = condition;

  return (
    <div className="space-y-3">
      {c.kind !== "time_window" ? (
        <MarketBinding
          current={c.market}
          doc={doc}
          onPick={(ref, meta) => bindMarket(id, ref, meta)}
        />
      ) : null}

      {c.kind === "price" ? (
        <>
          <Field label="Direction">
            <Segmented
              options={[
                { value: "lte", label: "drops below" },
                { value: "gte", label: "rises above" },
              ]}
              value={c.comparator}
              onChange={(comparator) => updateCondition(id, { ...c, comparator })}
              size="md"
            />
          </Field>
          <Field label="Price">
            <NumberInput
              value={toCents(c.threshold)}
              onChange={(v) => updateCondition(id, { ...c, threshold: fromCents(v) })}
              suffix="¢"
              min={1}
              max={99}
            />
          </Field>
        </>
      ) : null}

      {c.kind === "spread" ? (
        <>
          <Field label="Spread is">
            <Segmented
              options={[
                { value: "lte", label: "tighter than" },
                { value: "gte", label: "wider than" },
              ]}
              value={c.comparator}
              onChange={(comparator) => updateCondition(id, { ...c, comparator })}
              size="md"
            />
          </Field>
          <Field label="Spread">
            <NumberInput
              value={toCents(c.threshold)}
              onChange={(v) => updateCondition(id, { ...c, threshold: fromCents(v) })}
              suffix="¢"
              min={1}
              max={99}
            />
          </Field>
        </>
      ) : null}

      {c.kind === "cumulative_notional" ? (
        <>
          <Field label="At least">
            <NumberInput
              value={c.minNotional}
              onChange={(v) => updateCondition(id, { ...c, minNotional: Math.max(1, v) })}
              suffix="USD"
              min={1}
            />
          </Field>
          <Field label="Counting orders up to">
            <NumberInput
              value={toCents(c.priceBound)}
              onChange={(v) => updateCondition(id, { ...c, priceBound: fromCents(v) })}
              suffix="¢"
              min={1}
              max={99}
            />
          </Field>
          <Field label="Book side">
            <Segmented
              options={[
                { value: "ask", label: "sellers (asks)" },
                { value: "bid", label: "buyers (bids)" },
              ]}
              value={c.source}
              onChange={(source) => updateCondition(id, { ...c, source })}
              size="md"
            />
          </Field>
        </>
      ) : null}

      {c.kind === "visible_levels" ? (
        <>
          <Field label="At least">
            <NumberInput
              value={c.minLevels}
              onChange={(v) => updateCondition(id, { ...c, minLevels: Math.max(1, Math.round(v)) })}
              suffix="levels"
              min={1}
            />
          </Field>
          <Field label="Counting levels up to">
            <NumberInput
              value={toCents(c.priceBound)}
              onChange={(v) => updateCondition(id, { ...c, priceBound: fromCents(v) })}
              suffix="¢"
              min={1}
              max={99}
            />
          </Field>
        </>
      ) : null}

      {c.kind === "time_window" ? (
        <>
          <Field label="From (optional)">
            <input
              type="datetime-local"
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-brand"
              value={c.startMs ? new Date(c.startMs).toISOString().slice(0, 16) : ""}
              onChange={(e) =>
                updateCondition(id, {
                  ...c,
                  startMs: e.target.value ? new Date(e.target.value).getTime() : null,
                })
              }
            />
          </Field>
          <Field label="Until (optional)">
            <input
              type="datetime-local"
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-brand"
              value={c.endMs ? new Date(c.endMs).toISOString().slice(0, 16) : ""}
              onChange={(e) =>
                updateCondition(id, {
                  ...c,
                  endMs: e.target.value ? new Date(e.target.value).getTime() : null,
                })
              }
            />
          </Field>
        </>
      ) : null}

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={() => toggleNot(id)}>
          NOT
        </Button>
        <Button variant="danger" size="sm" onClick={() => removeNode(id)}>
          <Trash2 size={12} aria-hidden /> Remove
        </Button>
      </div>
    </div>
  );
}

function ActionEditor() {
  const doc = useBuilderStore((s) => s.doc);
  const setAction = useBuilderStore((s) => s.setAction);
  const setLimits = useBuilderStore((s) => s.setLimits);
  const bindMarket = useBuilderStore((s) => s.bindMarket);
  const a = doc.action;

  const mode = a.kind === "alert" ? "alert" : a.kind === "order" ? a.execution : "alert";

  const setMode = (m: "alert" | "prepare" | "auto") => {
    if (m === "alert") {
      setAction({ kind: "alert" });
      return;
    }
    const base =
      a.kind === "order"
        ? a
        : {
            kind: "order" as const,
            market: UNBOUND,
            side: "BUY" as const,
            price: 0.5,
            size: 10,
            orderType: "GTC" as const,
            execution: "prepare" as const,
          };
    setAction({ ...base, execution: m });
  };

  return (
    <div className="space-y-3">
      <Field label="When it triggers">
        <Segmented
          options={[
            { value: "alert", label: "Alert only" },
            { value: "prepare", label: "Ask to sign" },
            { value: "auto", label: "Auto" },
          ]}
          value={mode}
          onChange={(m) => setMode(m)}
          size="md"
        />
      </Field>

      {a.kind === "order" ? (
        <>
          <MarketBinding
            current={a.market}
            doc={doc}
            onPick={(ref, meta) => bindMarket("action", ref, meta)}
          />
          <Field label="Side">
            <Segmented
              options={[
                { value: "BUY", label: "Buy" },
                { value: "SELL", label: "Sell" },
              ]}
              value={a.side}
              onChange={(side) => setAction({ ...a, side })}
              size="md"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Limit price">
              <NumberInput
                value={toCents(a.price)}
                onChange={(v) => setAction({ ...a, price: fromCents(v) })}
                suffix="¢"
                min={1}
                max={99}
              />
            </Field>
            <Field label="Size">
              <NumberInput
                value={a.size}
                onChange={(v) => setAction({ ...a, size: Math.max(1, v) })}
                suffix="shares"
                min={1}
              />
            </Field>
          </div>
          <p className="tabular text-[11px] text-muted">
            Max cost ≈ ${(a.price * a.size).toFixed(2)}
          </p>

          {a.execution === "auto" ? (
            <div className="space-y-2 rounded-lg border border-brand/40 bg-brand-soft/40 p-3">
              <p className="text-[12px] font-semibold text-fg">Auto-mode spending limits</p>
              <p className="text-[11px] leading-snug text-muted">
                Orders place themselves from your Arima trading wallet, capped by these limits.
                Required before arming.
              </p>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Per order">
                  <NumberInput
                    value={doc.limits?.maxNotionalPerOrder ?? 0}
                    onChange={(v) =>
                      setLimits({
                        maxNotionalPerOrder: v,
                        maxDailyNotional: doc.limits?.maxDailyNotional ?? v,
                        maxTotalNotional: doc.limits?.maxTotalNotional ?? v,
                      })
                    }
                    suffix="$"
                    min={1}
                  />
                </Field>
                <Field label="Per day">
                  <NumberInput
                    value={doc.limits?.maxDailyNotional ?? 0}
                    onChange={(v) =>
                      setLimits({
                        maxNotionalPerOrder: doc.limits?.maxNotionalPerOrder ?? v,
                        maxDailyNotional: v,
                        maxTotalNotional: doc.limits?.maxTotalNotional ?? v,
                      })
                    }
                    suffix="$"
                    min={1}
                  />
                </Field>
                <Field label="Total">
                  <NumberInput
                    value={doc.limits?.maxTotalNotional ?? 0}
                    onChange={(v) =>
                      setLimits({
                        maxNotionalPerOrder: doc.limits?.maxNotionalPerOrder ?? v,
                        maxDailyNotional: doc.limits?.maxDailyNotional ?? v,
                        maxTotalNotional: v,
                      })
                    }
                    suffix="$"
                    min={1}
                  />
                </Field>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function StrategyEditor() {
  const doc = useBuilderStore((s) => s.doc);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  const setHoldsFor = useBuilderStore((s) => s.setHoldsFor);
  const setMaxDataAge = useBuilderStore((s) => s.setMaxDataAge);
  const setRecurrence = useBuilderStore((s) => s.setRecurrence);

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
        />
      </Field>
      <Field label="Conditions must hold for">
        <Segmented
          options={HOLD_OPTIONS}
          value={String(doc.holdsForMs)}
          onChange={(v) => setHoldsFor(Number(v))}
          size="md"
        />
      </Field>
      <Field label="How often">
        <Segmented
          options={[
            { value: "once", label: "Trigger once" },
            { value: "repeat", label: "Repeat" },
          ]}
          value={doc.recurrence.kind}
          onChange={(v) =>
            setRecurrence(
              v === "once"
                ? { kind: "once" }
                : { kind: "repeat", maxRepeats: 5, cooldownMs: 600_000 },
            )
          }
          size="md"
        />
      </Field>
      {doc.recurrence.kind === "repeat" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max repeats">
            <NumberInput
              value={doc.recurrence.maxRepeats}
              onChange={(v) =>
                setRecurrence({
                  kind: "repeat",
                  maxRepeats: Math.max(2, Math.round(v)),
                  cooldownMs:
                    doc.recurrence.kind === "repeat" ? doc.recurrence.cooldownMs : 600_000,
                })
              }
              suffix="×"
              min={2}
              max={100}
            />
          </Field>
          <Field label="Cooldown">
            <NumberInput
              value={Math.round(
                (doc.recurrence.kind === "repeat" ? doc.recurrence.cooldownMs : 0) / 60_000,
              )}
              onChange={(v) =>
                setRecurrence({
                  kind: "repeat",
                  maxRepeats: doc.recurrence.kind === "repeat" ? doc.recurrence.maxRepeats : 5,
                  cooldownMs: Math.max(0, Math.round(v)) * 60_000,
                })
              }
              suffix="min"
              min={0}
            />
          </Field>
        </div>
      ) : null}
      <details className="rounded-lg border border-border bg-surface-2 px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-muted">Advanced</summary>
        <div className="mt-2 space-y-2">
          <Field label="Market data freshness">
            <Segmented
              options={FRESH_OPTIONS}
              value={String(doc.maxDataAgeMs)}
              onChange={(v) => setMaxDataAge(Number(v))}
              size="md"
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

export function Inspector({ className }: { className?: string }) {
  const doc = useBuilderStore((s) => s.doc);
  const selected = doc.selectedNodeId;

  let title = "Strategy settings";
  let body: React.ReactNode = <StrategyEditor />;

  if (selected === "action") {
    title = "Action";
    body = <ActionEditor />;
  } else if (selected && selected !== "root" && !selected.startsWith("market:")) {
    const node = findNode(doc.expr, selected);
    if (node?.type === "condition") {
      title = "Condition";
      body = <ConditionEditor id={node.id} condition={node.condition} />;
    } else if (node?.type === "group") {
      title = "Logic group";
      body = <GroupEditor id={node.id} op={node.op} />;
    }
  }

  return (
    <aside
      className={cn(
        "space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel",
        className,
      )}
    >
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {body}
    </aside>
  );
}

function GroupEditor({ id, op }: { id: string; op: "and" | "or" | "not" }) {
  const doc = useBuilderStore((s) => s.doc);
  const removeNode = useBuilderStore((s) => s.removeNode);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  void doc;
  void setRootOp;
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted">
        {op === "not"
          ? "This flips its condition: the strategy needs it to be false."
          : op === "and"
            ? "Every condition inside must hold."
            : "Any one condition inside is enough."}
      </p>
      <Button variant="danger" size="sm" onClick={() => removeNode(id)}>
        <Trash2 size={12} aria-hidden /> Remove group
      </Button>
    </div>
  );
}
