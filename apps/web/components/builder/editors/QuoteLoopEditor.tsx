"use client";

/** quote_loop: the rewards-farming maker loop, parameterized on the canvas. */
import Link from "next/link";
import type { QuoteLoopAction } from "@mx2/rules";
import { useBuilderStore } from "@/lib/smart-orders/store";
import type { MarketSearchResult } from "@/lib/smart-orders/queries";
import { MarketSearch } from "../MarketSearch";
import { Field, NumberInput } from "./fields";

export function QuoteLoopForm({
  action,
  makerLoop,
}: {
  action: QuoteLoopAction;
  makerLoop: boolean;
}) {
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
