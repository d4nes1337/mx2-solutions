"use client";

/**
 * Condition parameter editor. One implementation for both editing surfaces:
 * the workspace panel's Block tab AND the expanded canvas node (hybrid UX —
 * D-025). Controls carry `nodrag` so React Flow never starts a node drag.
 */
import { Trash2 } from "lucide-react";
import type { ConditionV2 } from "@mx2/rules";
import { Button, Segmented } from "@/components/ui";
import { findNode, UNBOUND } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { Field, MarketBinding, NumberInput, fromCents, toCents } from "./fields";

export const CONDITION_KIND_OPTIONS = [
  { value: "price", label: "Price" },
  { value: "price_move", label: "Move" },
  { value: "trailing", label: "Trailing" },
  { value: "spread", label: "Spread" },
  { value: "cumulative_notional", label: "Liquidity" },
  { value: "visible_levels", label: "Levels" },
  { value: "time_window", label: "Time" },
] as const;

/** Fresh condition of a given kind, keeping the market binding when possible. */
export const defaultCondition = (kind: ConditionV2["kind"], market = UNBOUND): ConditionV2 =>
  kind === "price"
    ? { kind, market, source: "ask", comparator: "lte", threshold: 0.5 }
    : kind === "price_move"
      ? { kind, market, direction: "drop", deltaThreshold: 0.05, windowMs: 600_000 }
      : kind === "trailing"
        ? { kind, market, mode: "stop", source: "bid", offset: 0.05 }
        : kind === "spread"
          ? { kind, market, comparator: "lte", threshold: 0.02 }
          : kind === "cumulative_notional"
            ? { kind, market, source: "ask", priceBound: 0.5, minNotional: 1000 }
            : kind === "visible_levels"
              ? { kind, market, source: "ask", priceBound: 0.5, minLevels: 3 }
              : { kind: "time_window", startMs: null, endMs: null };

export function ConditionEditor({ id }: { id: string }) {
  const doc = useBuilderStore((s) => s.doc);
  const updateCondition = useBuilderStore((s) => s.updateCondition);
  const bindMarket = useBuilderStore((s) => s.bindMarket);
  const toggleNot = useBuilderStore((s) => s.toggleNot);
  const removeNode = useBuilderStore((s) => s.removeNode);

  // The node may already be gone mid-render (deleted while selected).
  const found = findNode(doc.expr, id);
  if (!found || found.type !== "condition") return null;
  const c = found.condition;

  /** Switching the condition type keeps the market binding where possible. */
  const switchKind = (kind: ConditionV2["kind"]) => {
    if (kind === c.kind) return;
    const market = c.kind !== "time_window" ? c.market : UNBOUND;
    updateCondition(id, defaultCondition(kind, market));
  };

  return (
    <div className="space-y-3">
      <Field label="Condition type">
        <div className="nodrag">
          <Segmented
            options={[...CONDITION_KIND_OPTIONS]}
            value={c.kind}
            onChange={switchKind}
            size="sm"
            grow={3}
          />
        </div>
      </Field>

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
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "lte", label: "drops below" },
                  { value: "gte", label: "rises above" },
                ]}
                value={c.comparator}
                onChange={(comparator) => updateCondition(id, { ...c, comparator })}
                size="md"
                grow
              />
            </div>
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

      {c.kind === "price_move" ? (
        <>
          <Field label="Direction">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "drop", label: "drops" },
                  { value: "rise", label: "rises" },
                  { value: "either", label: "either way" },
                ]}
                value={c.direction}
                onChange={(direction) => updateCondition(id, { ...c, direction })}
                size="md"
                grow
              />
            </div>
          </Field>
          <Field label="Moves at least">
            <NumberInput
              value={toCents(c.deltaThreshold)}
              onChange={(v) => updateCondition(id, { ...c, deltaThreshold: fromCents(v) })}
              suffix="¢"
              min={1}
              max={99}
            />
          </Field>
          <Field label="Within the last">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "60000", label: "1m" },
                  { value: "300000", label: "5m" },
                  { value: "600000", label: "10m" },
                  { value: "1800000", label: "30m" },
                  { value: "3600000", label: "1h" },
                ]}
                value={String(c.windowMs)}
                onChange={(v) => updateCondition(id, { ...c, windowMs: Number(v) })}
                size="md"
                grow
              />
            </div>
          </Field>
          <p className="text-[11px] leading-snug text-muted">
            Live detection uses tick-by-tick data; draft checks and backtests use 1-minute candles,
            so very short windows look coarser there.
          </p>
        </>
      ) : null}

      {c.kind === "trailing" ? (
        <>
          <Field label="Watch for">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "stop", label: "fall from peak" },
                  { value: "entry", label: "rebound off low" },
                ]}
                value={c.mode}
                onChange={(mode) =>
                  updateCondition(id, {
                    ...c,
                    mode,
                    // Reference side follows the mode: stops read what you
                    // can sell at (bid), entries what you must pay (ask).
                    source: mode === "stop" ? "bid" : "ask",
                  })
                }
                size="md"
                grow
              />
            </div>
          </Field>
          <Field label="Trailing distance">
            <NumberInput
              value={toCents(c.offset)}
              onChange={(v) =>
                updateCondition(id, { ...c, offset: Math.min(0.5, Math.max(0.01, v / 100)) })
              }
              suffix="¢"
              min={1}
              max={50}
            />
          </Field>
          <p className="text-[11px] leading-snug text-muted">
            {c.mode === "stop"
              ? "Arms at the current price, follows the peak up, and fires when the price slips this far below it — the classic way to protect a position going the wrong way."
              : "Arms at the current price, follows the low down, and fires when the price bounces this far off it — a patient way to enter a falling market."}{" "}
            The tracked level survives restarts and never moves on stale data.
          </p>
        </>
      ) : null}

      {c.kind === "spread" ? (
        <>
          <Field label="Spread is">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "lte", label: "tighter than" },
                  { value: "gte", label: "wider than" },
                ]}
                value={c.comparator}
                onChange={(comparator) => updateCondition(id, { ...c, comparator })}
                size="md"
                grow
              />
            </div>
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
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "ask", label: "sellers (asks)" },
                  { value: "bid", label: "buyers (bids)" },
                ]}
                value={c.source}
                onChange={(source) => updateCondition(id, { ...c, source })}
                size="md"
                grow
              />
            </div>
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
              className="nodrag w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-brand"
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
              className="nodrag w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-brand"
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

      <div className="nodrag flex items-center gap-2 border-t border-border pt-3">
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
