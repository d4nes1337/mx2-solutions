"use client";

/**
 * Action editor — the strategy's single "then do this" block, for both the
 * panel Block tab and the expanded canvas node. Handles ALL four engine action
 * kinds (alert / order / stop_strategy / quote_loop). The kind selector
 * converts explicitly with a discard confirmation, and the alert vs order
 * split is a kind decision — so switching execution can never silently
 * clobber a farming loop or a stop link (the old data-loss bug).
 */
import { useState } from "react";
import Link from "next/link";
import type { ActionV2, OrderActionV2, QuoteLoopAction } from "@mx2/rules";
import { Button, Segmented } from "@/components/ui";
import { UNBOUND } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useFeatureFlags } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { useStrategies, type MarketSearchResult } from "@/lib/smart-orders/queries";
import { MarketSearch } from "../MarketSearch";
import { CONDITION_KIND_OPTIONS, defaultCondition } from "./ConditionEditor";
import { Field, MarketBinding, NumberInput, fromCents, toCents } from "./fields";
import { OrderCostPreview } from "./OrderCostPreview";

const ENTRY_WINDOW_OPTIONS = [
  { value: "180000", label: "3m" },
  { value: "300000", label: "5m" },
  { value: "900000", label: "15m" },
  { value: "3600000", label: "1h" },
];

type ActionKind = ActionV2["kind"];

const KIND_LABELS: Record<ActionKind, string> = {
  alert: "Alert",
  order: "Order",
  stop_strategy: "Stop a strategy",
  quote_loop: "Farm rewards",
};

export const defaultActionFor = (kind: ActionKind): ActionV2 => {
  switch (kind) {
    case "alert":
      return { kind: "alert" };
    case "order":
      return {
        kind: "order",
        market: UNBOUND,
        side: "BUY",
        price: 0.5,
        size: 10,
        orderType: "GTC",
        execution: "prepare",
      };
    case "stop_strategy":
      return { kind: "stop_strategy", targetStrategyId: "" };
    case "quote_loop":
      return {
        kind: "quote_loop",
        market: { conditionId: "", yesTokenId: "", noTokenId: "" },
        sizeShares: 50,
        targetSpreadCents: 2,
        requoteToleranceCents: 1,
        maxInventoryShares: 100,
        maxCapitalUsd: 60,
        maxDailyLossUsd: 10,
      };
  }
};

/** Does the current action carry configuration worth a discard confirmation? */
const hasMeaningfulConfig = (a: ActionV2): boolean =>
  (a.kind === "order" && a.market.tokenId !== "") ||
  (a.kind === "stop_strategy" && a.targetStrategyId !== "") ||
  (a.kind === "quote_loop" && a.market.conditionId !== "");

export function ActionEditor() {
  const doc = useBuilderStore((s) => s.doc);
  const setAction = useBuilderStore((s) => s.setAction);
  const setLimits = useBuilderStore((s) => s.setLimits);
  const bindMarket = useBuilderStore((s) => s.bindMarket);
  const flags = useFeatureFlags();
  const [pendingKind, setPendingKind] = useState<ActionKind | null>(null);
  const a = doc.action;

  const makerLoop = Boolean(flags.data?.makerLoop);
  const kinds: ActionKind[] = ["alert", "order", "stop_strategy"];
  if (makerLoop || a.kind === "quote_loop") kinds.push("quote_loop");
  const kindOptions = kinds.map((k) => ({ value: k, label: KIND_LABELS[k] }));

  const requestKind = (kind: ActionKind) => {
    if (kind === a.kind) return;
    if (hasMeaningfulConfig(a)) {
      setPendingKind(kind);
      return;
    }
    setAction(defaultActionFor(kind));
  };

  return (
    <div className="space-y-3">
      <Field label="When it triggers">
        <div className="nodrag">
          <Segmented
            options={kindOptions}
            value={a.kind}
            onChange={requestKind}
            size="sm"
            grow={kindOptions.length > 3 ? 2 : true}
          />
        </div>
      </Field>

      {pendingKind ? (
        <div className="nodrag space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5">
          <p className="text-[12px] leading-snug text-warn">
            Switching to “{KIND_LABELS[pendingKind]}” discards this action&apos;s current settings.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setAction(defaultActionFor(pendingKind));
                setPendingKind(null);
              }}
            >
              Switch
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingKind(null)}>
              Keep current
            </Button>
          </div>
        </div>
      ) : null}

      {a.kind === "alert" ? (
        <p className="text-[12px] leading-snug text-muted">
          You&apos;ll get a notification with full trigger evidence — nothing trades.
        </p>
      ) : null}

      {a.kind === "stop_strategy" ? <StopStrategyForm targetId={a.targetStrategyId} /> : null}

      {a.kind === "quote_loop" ? <QuoteLoopForm action={a} makerLoop={makerLoop} /> : null}

      {a.kind === "order" ? (
        <>
          <Field label="Execution">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "prepare", label: "Ask to sign" },
                  { value: "auto", label: "Auto" },
                ]}
                value={a.execution}
                onChange={(execution) => setAction({ ...a, execution })}
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
                grow
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
                  grow
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

/** stop_strategy: pick one of the user's own strategies to stop on trigger. */
function StopStrategyForm({ targetId }: { targetId: string }) {
  const session = useSession();
  const setAction = useBuilderStore((s) => s.setAction);
  const strategies = useStrategies(Boolean(session.data));

  const rows = strategies.data?.strategies ?? [];
  if (!session.data) {
    return (
      <p className="text-[12px] leading-snug text-muted">
        Sign in to pick which of your Smart Orders this one should stop.
      </p>
    );
  }
  return (
    <Field label="Smart Order to stop">
      <select
        className="nodrag w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-brand"
        value={targetId}
        onChange={(e) => setAction({ kind: "stop_strategy", targetStrategyId: e.target.value })}
      >
        <option value="">Pick a strategy…</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name || r.id.slice(0, 8)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** quote_loop: the rewards-farming maker loop, parameterized on the canvas. */
function QuoteLoopForm({ action, makerLoop }: { action: QuoteLoopAction; makerLoop: boolean }) {
  const setAction = useBuilderStore((s) => s.setAction);
  const q = action;

  if (!makerLoop) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-2.5">
        <p className="text-[12px] leading-snug text-muted">
          Rewards farming isn&apos;t enabled on this server yet. This action is kept as-is — use the
          farming cockpit to explore reward pools.
        </p>
        <Link
          href="/farming"
          className="nodrag text-[12px] font-medium text-accent hover:underline"
        >
          Open the farming cockpit →
        </Link>
      </div>
    );
  }

  const pickMarket = (r: MarketSearchResult) => {
    const [yes, no] = r.tokenIds;
    if (!yes || !no) return;
    setAction({
      ...q,
      market: {
        conditionId: r.conditionId,
        yesTokenId: yes,
        noTokenId: no,
        title: r.title,
        negRisk: r.negRisk,
      },
      // Seed params from the market's rewards program when known.
      ...(r.rewardsMinSize ? { sizeShares: Math.max(q.sizeShares, r.rewardsMinSize) } : {}),
      ...(r.rewardsMaxSpread
        ? {
            targetSpreadCents: Math.min(q.targetSpreadCents, Math.max(0.5, r.rewardsMaxSpread - 1)),
          }
        : {}),
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-snug text-muted">
        Rests post-only bids on BOTH outcomes near the midpoint to earn liquidity rewards, merging
        completed pairs back to cash. Runs in shadow mode first — it simulates and reports before
        any real quote is placed.
      </p>
      {q.market.conditionId !== "" ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5">
          <span className="truncate text-[12px] text-fg">
            {q.market.title ?? q.market.conditionId}
          </span>
          <span className="shrink-0 rounded-full border border-brand/40 bg-brand-soft px-2 text-[10px] font-semibold text-accent">
            YES + NO
          </span>
        </div>
      ) : (
        <p className="text-[12px] font-medium text-warn">Pick a market to quote:</p>
      )}
      <div className="nodrag nowheel">
        <MarketSearch onPickResult={pickMarket} placeholder="Search rewards markets…" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Size per side">
          <NumberInput
            value={q.sizeShares}
            onChange={(v) => setAction({ ...q, sizeShares: Math.max(1, Math.round(v)) })}
            suffix="shares"
            min={1}
          />
        </Field>
        <Field label="Half-spread">
          <NumberInput
            value={q.targetSpreadCents}
            onChange={(v) => setAction({ ...q, targetSpreadCents: Math.min(10, Math.max(0.5, v)) })}
            suffix="¢"
            min={0.5}
            max={10}
            step={0.5}
          />
        </Field>
        <Field label="Re-quote tolerance">
          <NumberInput
            value={q.requoteToleranceCents}
            onChange={(v) =>
              setAction({ ...q, requoteToleranceCents: Math.min(10, Math.max(0.5, v)) })
            }
            suffix="¢"
            min={0.5}
            max={10}
            step={0.5}
          />
        </Field>
        <Field label="Max net inventory">
          <NumberInput
            value={q.maxInventoryShares}
            onChange={(v) => setAction({ ...q, maxInventoryShares: Math.max(1, Math.round(v)) })}
            suffix="shares"
            min={1}
          />
        </Field>
        <Field label="Max capital">
          <NumberInput
            value={q.maxCapitalUsd}
            onChange={(v) => setAction({ ...q, maxCapitalUsd: Math.max(1, Math.round(v)) })}
            suffix="$"
            min={1}
          />
        </Field>
        <Field label="Max daily loss">
          <NumberInput
            value={q.maxDailyLossUsd}
            onChange={(v) => setAction({ ...q, maxDailyLossUsd: Math.max(1, Math.round(v)) })}
            suffix="$"
            min={1}
          />
        </Field>
      </div>
      <p className="text-[10px] leading-snug text-faint">
        Conditions on the canvas act as an optional gate — quotes rest only while they hold. No
        conditions = always on.
      </p>
    </div>
  );
}

/** Root logic node's controls: the top-level ALL-OF / ANY-OF toggle. */
export function RootLogicEditor() {
  const doc = useBuilderStore((s) => s.doc);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  return (
    <div className="nodrag">
      <Segmented
        options={[
          { value: "and", label: "ALL of these" },
          { value: "or", label: "ANY of these" },
        ]}
        value={doc.expr.op === "or" ? "or" : "and"}
        onChange={(op) => setRootOp(op)}
        size="sm"
        grow
      />
    </div>
  );
}

/** Non-root group node's controls: explanation, add-condition-here, remove. */
export function GroupEditor({ id, op }: { id: string; op: "and" | "or" | "not" }) {
  const removeNode = useBuilderStore((s) => s.removeNode);
  return (
    <div className="nodrag space-y-2">
      <p className="text-[11px] leading-snug text-muted">
        {op === "not"
          ? "Flips its condition: the strategy needs it to be false."
          : op === "and"
            ? "Every condition inside must hold."
            : "Any one condition inside is enough."}
      </p>
      {op !== "not" ? <AddConditionIntoGroup parentId={id} /> : null}
      <Button variant="danger" size="sm" onClick={() => removeNode(id)}>
        Remove group
      </Button>
    </div>
  );
}

function AddConditionIntoGroup({ parentId }: { parentId: string }) {
  const addCondition = useBuilderStore((s) => s.addCondition);
  return (
    <div className="flex flex-wrap gap-1.5">
      {CONDITION_KIND_OPTIONS.map((k) => (
        <button
          key={k.value}
          type="button"
          onClick={() => addCondition(defaultCondition(k.value), parentId)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:border-brand/50 hover:text-fg"
        >
          + {k.label}
        </button>
      ))}
    </div>
  );
}
