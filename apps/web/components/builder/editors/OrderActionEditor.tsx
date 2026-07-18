"use client";

/**
 * Order action editor — the few decisions that matter up front (execution
 * mode, market, side, price, size), everything else behind Advanced. The old
 * single-scroll form stacked ~12 controls and buried the arm button; the
 * essentials now fit one screen with zero explanatory paragraphs.
 */
import { useState } from "react";
import type { OrderActionV2 } from "@mx2/rules";
import { Segmented } from "@/components/ui";
import { loadLimitPrefs } from "@/lib/smart-orders/limit-prefs";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { Field, MarketBinding, NumberInput, fromCents, toCents } from "./fields";
import { OrderCostPreview } from "./OrderCostPreview";

const ENTRY_WINDOW_OPTIONS = [
  { value: "180000", label: "3m" },
  { value: "300000", label: "5m" },
  { value: "900000", label: "15m" },
  { value: "3600000", label: "1h" },
];

const STYLE_HINTS: Record<OrderActionV2["orderType"], string> = {
  GTC: "Rests on the book until filled or cancelled — no trading fee.",
  GTD: "Rests for the entry window after the trigger, then expires — no trading fee.",
  FAK: "Fills what the book offers at your price now; the rest cancels. Taker fee applies.",
  FOK: "Fills the full size immediately or not at all. Taker fee applies.",
};

const DEFAULT_LIMIT_FROM_ORDER = (a: OrderActionV2) => {
  const perOrder = Math.max(1, Math.ceil(a.price * a.size));
  return {
    maxNotionalPerOrder: perOrder,
    maxDailyNotional: perOrder,
    maxTotalNotional: perOrder,
  };
};

export function OrderActionEditor({ action: a }: { action: OrderActionV2 }) {
  const doc = useBuilderStore((s) => s.doc);
  const setAction = useBuilderStore((s) => s.setAction);
  const setLimits = useBuilderStore((s) => s.setLimits);
  const bindMarket = useBuilderStore((s) => s.bindMarket);
  const [editingLimits, setEditingLimits] = useState(false);

  const switchExecution = (execution: "prepare" | "auto") => {
    setAction({ ...a, execution });
    // First switch to auto: seed the caps from last-used values (or this
    // order's cost) so arming isn't blocked on an empty form. Still editable,
    // still required, still validated.
    if (execution === "auto" && doc.limits === null) {
      setLimits(loadLimitPrefs() ?? DEFAULT_LIMIT_FROM_ORDER(a));
    }
  };

  const limits = doc.limits;
  const limitsSummary = limits
    ? `$${limits.maxNotionalPerOrder}/order · $${limits.maxDailyNotional}/day · $${limits.maxTotalNotional} total`
    : null;

  return (
    <>
      <Field label="Execution">
        <div className="nodrag">
          <Segmented
            options={[
              { value: "prepare", label: "Ask to sign" },
              { value: "auto", label: "Auto" },
            ]}
            value={a.execution}
            onChange={switchExecution}
            size="md"
            grow
          />
        </div>
      </Field>
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
              <div className="nodrag">
                <Segmented
                  options={ENTRY_WINDOW_OPTIONS}
                  value={String(a.expiresAfterMs ?? 300_000)}
                  onChange={(v) => setAction({ ...a, expiresAfterMs: Number(v) })}
                  size="md"
                  grow
                />
              </div>
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
