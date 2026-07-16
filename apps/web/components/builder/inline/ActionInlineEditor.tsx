"use client";

/**
 * Inline editor rendered inside the selected action node: alert / ask-to-sign /
 * auto mode, order parameters and auto-mode spending limits.
 */
import type { OrderActionV2 } from "@mx2/rules";
import { Button, Segmented } from "@/components/ui";
import { UNBOUND } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { Field, MarketBinding, NumberInput, fromCents, toCents } from "./fields";
import { OrderCostPreview } from "./OrderCostPreview";

const ENTRY_WINDOW_OPTIONS = [
  { value: "180000", label: "3m" },
  { value: "300000", label: "5m" },
  { value: "900000", label: "15m" },
  { value: "3600000", label: "1h" },
];

export function ActionInlineEditor() {
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
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <Field label="When it triggers">
        <div className="nodrag">
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
        </div>
      </Field>

      {a.kind === "order" ? (
        <>
          <MarketBinding
            current={a.market}
            doc={doc}
            onPick={(ref, meta) => bindMarket("action", ref, meta)}
          />
          <Field label="Side">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "BUY", label: "Buy" },
                  { value: "SELL", label: "Sell" },
                ]}
                value={a.side}
                onChange={(side) => setAction({ ...a, side })}
                size="md"
              />
            </div>
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

          <Field label="Execution style">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "GTC", label: "Rest" },
                  { value: "GTD", label: "Timed" },
                  { value: "FAK", label: "Instant" },
                  { value: "FOK", label: "All-or-none" },
                ]}
                value={a.orderType}
                onChange={(orderType) => {
                  // Strip fields the new style doesn't support; seed GTD's window.
                  const next: OrderActionV2 = { ...a, orderType };
                  const mutable = next as {
                    postOnly?: boolean;
                    expiresAfterMs?: number;
                  };
                  if (orderType !== "GTD") delete mutable.expiresAfterMs;
                  else if (mutable.expiresAfterMs === undefined) mutable.expiresAfterMs = 300_000;
                  if (orderType === "FOK" || orderType === "FAK") delete mutable.postOnly;
                  setAction(next);
                }}
                size="sm"
              />
            </div>
          </Field>
          <p className="text-[10px] leading-snug text-faint">
            {a.orderType === "GTC"
              ? "Rests on the book until filled or cancelled — no trading fee."
              : a.orderType === "GTD"
                ? "Rests for the entry window after the trigger, then expires — no trading fee."
                : a.orderType === "FAK"
                  ? "Fills whatever the book offers at your price immediately; the rest is cancelled. Pays the taker fee."
                  : "Fills the full size immediately or not at all. Pays the taker fee."}
          </p>

          {a.orderType === "GTD" ? (
            <Field label="Entry window (after trigger)">
              <div className="nodrag">
                <Segmented
                  options={ENTRY_WINDOW_OPTIONS}
                  value={String(a.expiresAfterMs ?? 300_000)}
                  onChange={(v) => setAction({ ...a, expiresAfterMs: Number(v) })}
                  size="md"
                />
              </div>
            </Field>
          ) : null}

          {a.orderType === "GTC" || a.orderType === "GTD" ? (
            <label className="nodrag flex items-center gap-2 text-[12px] text-fg">
              <input
                type="checkbox"
                checked={a.postOnly ?? false}
                onChange={(e) =>
                  setAction(
                    e.target.checked
                      ? { ...a, postOnly: true }
                      : (() => {
                          const next = { ...a };
                          delete (next as { postOnly?: boolean }).postOnly;
                          return next;
                        })(),
                  )
                }
              />
              Maker only (post-only) — reject instead of crossing the spread
            </label>
          ) : null}

          <OrderCostPreview action={a} />

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

/** Root logic node's inline control: the top-level ALL-OF / ANY-OF toggle. */
export function RootLogicInlineEditor() {
  const doc = useBuilderStore((s) => s.doc);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  return (
    <div className="nodrag mt-2 border-t border-border pt-2">
      <Segmented
        options={[
          { value: "and", label: "ALL of these" },
          { value: "or", label: "ANY of these" },
        ]}
        value={doc.expr.op === "or" ? "or" : "and"}
        onChange={(op) => setRootOp(op)}
        size="sm"
      />
    </div>
  );
}

/** Non-root group node's inline controls: explanation + remove. */
export function GroupInlineEditor({ id, op }: { id: string; op: "and" | "or" | "not" }) {
  const removeNode = useBuilderStore((s) => s.removeNode);
  return (
    <div className="nodrag mt-2 space-y-2 border-t border-border pt-2">
      <p className="max-w-[220px] text-[11px] leading-snug text-muted">
        {op === "not"
          ? "Flips its condition: the strategy needs it to be false."
          : op === "and"
            ? "Every condition inside must hold."
            : "Any one condition inside is enough."}
      </p>
      <Button variant="danger" size="sm" onClick={() => removeNode(id)}>
        Remove group
      </Button>
    </div>
  );
}
