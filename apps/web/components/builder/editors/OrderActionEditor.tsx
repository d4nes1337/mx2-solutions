"use client";

/**
 * Order action editor — the few decisions that matter up front (market, side,
 * price, size), everything else behind Advanced. Execution mode is chosen by
 * the parent ActionEditor's 3-way picker; this form only reflects it (the
 * auto-caps box appears when execution is "auto").
 */
import { useState } from "react";
import type { OrderActionV2 } from "@mx2/rules";
import { GTD_MAX_EXPIRES_AFTER_MS, GTD_MIN_EXPIRES_AFTER_MS } from "@mx2/rules";
import { Segmented } from "@/components/ui";
import { useBuilderStore } from "@/lib/strategies/store";
import { Field, MarketBinding, NumberInput, fromCents, toCents } from "./fields";
import { DurationField } from "./DurationField";
import { OrderCostPreview } from "./OrderCostPreview";

const ENTRY_WINDOW_PRESETS = [
  { value: 180_000, label: "3m" },
  { value: 300_000, label: "5m" },
  { value: 900_000, label: "15m" },
  { value: 3_600_000, label: "1h" },
];

const STYLE_HINTS: Record<OrderActionV2["orderType"], string> = {
  GTC: "Rests on the book until filled or cancelled — no trading fee.",
  GTD: "Rests for the entry window after the trigger, then expires — no trading fee.",
  FAK: "Fills what the book offers at your price now; the rest cancels. Taker fee applies.",
  FOK: "Fills the full size immediately or not at all. Taker fee applies.",
};

export function OrderActionEditor({ action: a }: { action: OrderActionV2 }) {
  const doc = useBuilderStore((s) => s.doc);
  const setAction = useBuilderStore((s) => s.setAction);
  const setLimits = useBuilderStore((s) => s.setLimits);
  const bindMarket = useBuilderStore((s) => s.bindMarket);
  const [editingLimits, setEditingLimits] = useState(false);

  const limits = doc.limits;
  const limitsSummary = limits
    ? `$${limits.maxNotionalPerOrder}/order · $${limits.maxDailyNotional}/day · $${limits.maxTotalNotional} total`
    : null;

  return (
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
            grow
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
      <p className="tabular text-[11px] text-muted">Max cost ≈ ${(a.price * a.size).toFixed(2)}</p>

      {a.execution === "auto" ? (
        <div className="nodrag rounded-lg border border-brand/40 bg-brand-soft/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span
              className="text-[12px] font-semibold text-fg"
              title="Hard caps for orders placed automatically from your Arima trading wallet. Required before arming."
            >
              Auto caps
            </span>
            {!editingLimits && limitsSummary ? (
              <button
                type="button"
                onClick={() => setEditingLimits(true)}
                className="tabular text-[11px] text-accent hover:underline"
              >
                {limitsSummary} — edit
              </button>
            ) : null}
          </div>
          {editingLimits || !limitsSummary ? (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Field label="Per order">
                <NumberInput
                  value={limits?.maxNotionalPerOrder ?? 0}
                  onChange={(v) =>
                    setLimits({
                      maxNotionalPerOrder: v,
                      maxDailyNotional: limits?.maxDailyNotional ?? v,
                      maxTotalNotional: limits?.maxTotalNotional ?? v,
                    })
                  }
                  suffix="$"
                  min={1}
                />
              </Field>
              <Field label="Per day">
                <NumberInput
                  value={limits?.maxDailyNotional ?? 0}
                  onChange={(v) =>
                    setLimits({
                      maxNotionalPerOrder: limits?.maxNotionalPerOrder ?? v,
                      maxDailyNotional: v,
                      maxTotalNotional: limits?.maxTotalNotional ?? v,
                    })
                  }
                  suffix="$"
                  min={1}
                />
              </Field>
              <Field label="Total">
                <NumberInput
                  value={limits?.maxTotalNotional ?? 0}
                  onChange={(v) =>
                    setLimits({
                      maxNotionalPerOrder: limits?.maxNotionalPerOrder ?? v,
                      maxDailyNotional: limits?.maxDailyNotional ?? v,
                      maxTotalNotional: v,
                    })
                  }
                  suffix="$"
                  min={1}
                />
              </Field>
            </div>
          ) : null}
        </div>
      ) : null}

      <details className="nodrag rounded-lg border border-border bg-surface-2 px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-muted">Advanced</summary>
        <div className="mt-2 space-y-3">
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
                grow
              />
            </div>
          </Field>
          <p className="text-[10px] leading-snug text-faint">{STYLE_HINTS[a.orderType]}</p>

          {a.orderType === "GTD" ? (
            <Field label="Entry window (after trigger)">
              <DurationField
                value={a.expiresAfterMs ?? 300_000}
                onChange={(ms) => setAction({ ...a, expiresAfterMs: ms })}
                presets={ENTRY_WINDOW_PRESETS}
                units={["minutes", "hours"]}
                min={GTD_MIN_EXPIRES_AFTER_MS}
                max={GTD_MAX_EXPIRES_AFTER_MS}
              />
            </Field>
          ) : null}

          {a.orderType === "GTC" || a.orderType === "GTD" ? (
            <label
              className="nodrag flex items-center gap-2 text-[12px] text-fg"
              title="Maker only: reject the order instead of crossing the spread"
            >
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
              Maker only (post-only)
            </label>
          ) : null}

          <OrderCostPreview action={a} />
        </div>
      </details>
    </>
  );
}
