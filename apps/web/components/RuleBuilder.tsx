"use client";

import { useMemo, useState } from "react";
import { useCreateRule, useOrderbook } from "@/lib/queries";
import { buildPredicates, evalPredicatesClient } from "@/lib/rules";
import { ApiError } from "@/lib/api";
import type { CreateRuleRequest, OrderSide } from "@/lib/types";
import { Badge, Button, ErrorNote, cn } from "./ui";

/**
 * Create a conditional rule on a market. Shows a live "would-trigger-now" panel
 * computed from the current orderbook (preview only — the worker re-evaluates
 * authoritatively). A trigger never auto-submits: it alerts + prepares an order
 * for manual confirmation.
 */
export function RuleBuilder({
  marketId,
  conditionId,
  tokenIds,
  outcomes,
  signedIn,
}: {
  marketId: string;
  conditionId: string;
  tokenIds: string[];
  outcomes: string[];
  signedIn: boolean;
}) {
  const create = useCreateRule();

  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const [side, setSide] = useState<OrderSide>("BUY");
  const [priceThreshold, setPriceThreshold] = useState("0.50");
  const [liquidity, setLiquidity] = useState(true);
  const [minNotional, setMinNotional] = useState("1000");
  const [minLevels, setMinLevels] = useState("3");
  const [windowMin, setWindowMin] = useState("10");
  const [maxAgeSec, setMaxAgeSec] = useState("2");
  const [actionPrice, setActionPrice] = useState("0.49");
  const [actionSize, setActionSize] = useState("100");
  const [formError, setFormError] = useState<string | null>(null);

  const tokenId = tokenIds[outcomeIdx];
  const orderbook = useOrderbook(marketId, outcomeIdx);

  const predicates = useMemo(
    () =>
      buildPredicates({
        side,
        priceThreshold: Number(priceThreshold),
        liquidity,
        minNotional: Number(minNotional),
        minLevels: Number(minLevels),
      }),
    [side, priceThreshold, liquidity, minNotional, minLevels],
  );

  const previewResults = useMemo(
    () => evalPredicatesClient(predicates, orderbook.data?.bids, orderbook.data?.asks),
    [predicates, orderbook.data],
  );
  const isStale = orderbook.data?.isStale ?? false;
  const allHold = previewResults.length > 0 && previewResults.every((r) => r.satisfied) && !isStale;

  const submit = () => {
    setFormError(null);
    if (!tokenId) {
      setFormError("No token id for the selected outcome.");
      return;
    }
    const windowMs = Math.round(Number(windowMin) * 60_000);
    const maxDataAgeMs = Math.round(Number(maxAgeSec) * 1_000);
    const price = Number(actionPrice);
    const size = Number(actionSize);
    if (!(price > 0 && price < 1)) return setFormError("Order price must be between 0 and 1.");
    if (!(size > 0)) return setFormError("Order size must be positive.");
    if (!(windowMs > 0)) return setFormError("Continuous window must be positive.");

    const req: CreateRuleRequest = {
      conditionId,
      tokenId,
      side,
      predicates,
      continuousWindowMs: windowMs,
      maxDataAgeMs,
      action: { kind: "prepare_order", side, price, size, orderType: "GTC" },
    };
    create.mutate(req);
  };

  const createError =
    create.error instanceof ApiError
      ? create.error.message
      : create.error instanceof Error
        ? create.error.message
        : null;

  if (!signedIn) {
    return <p className="text-xs text-muted">Sign in to create conditional rules.</p>;
  }

  return (
    <div className="space-y-3">
      {/* Outcome + direction */}
      <div className="flex gap-2">
        {(outcomes.length ? outcomes : ["YES", "NO"]).map((label, i) => (
          <button
            key={i}
            onClick={() => setOutcomeIdx(i)}
            disabled={!tokenIds[i]}
            className={cn(
              "flex-1 rounded-md border px-2 py-1.5 text-sm transition-colors disabled:opacity-30",
              outcomeIdx === i
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-border text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        {(["BUY", "SELL"] as OrderSide[]).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={cn(
              "flex-1 rounded-md border px-2 py-1.5 text-sm transition-colors",
              side === s
                ? s === "BUY"
                  ? "border-pos/50 bg-pos/15 text-pos"
                  : "border-neg/50 bg-neg/15 text-neg"
                : "border-border text-muted hover:text-fg",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {/* WHEN */}
      <div className="rounded-md border border-border bg-surface-2 p-3 text-xs">
        <div className="mb-2 font-semibold text-fg">WHEN (continuously, fail-closed)</div>
        <Field
          label={`best ${side === "BUY" ? "ask ≤" : "bid ≥"} (price)`}
          value={priceThreshold}
          onChange={setPriceThreshold}
        />
        <label className="mt-2 flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={liquidity}
            onChange={(e) => setLiquidity(e.target.checked)}
          />
          require liquidity depth
        </label>
        {liquidity ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="Σ notional ≥ $" value={minNotional} onChange={setMinNotional} />
            <Field label="min visible levels" value={minLevels} onChange={setMinLevels} />
          </div>
        ) : null}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label="continuous for (min)" value={windowMin} onChange={setWindowMin} />
          <Field label="max data age (s)" value={maxAgeSec} onChange={setMaxAgeSec} />
        </div>
      </div>

      {/* THEN */}
      <div className="rounded-md border border-border bg-surface-2 p-3 text-xs">
        <div className="mb-2 font-semibold text-fg">
          THEN prepare 1 GTC {side} limit (manual confirm)
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="limit price (0–1)" value={actionPrice} onChange={setActionPrice} />
          <Field label="size (shares)" value={actionSize} onChange={setActionSize} />
        </div>
      </div>

      {/* Live would-trigger-now */}
      <div className="rounded-md border border-border bg-surface-2 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-fg">Would trigger now?</span>
          {isStale ? (
            <Badge tone="warn">data stale</Badge>
          ) : allHold ? (
            <Badge tone="pos">all conditions hold</Badge>
          ) : (
            <Badge tone="neutral">not yet</Badge>
          )}
        </div>
        <div className="space-y-1">
          {previewResults.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <span className={cn(r.satisfied ? "text-pos" : "text-muted")}>
                {r.satisfied ? "✓" : "○"} {r.label}
              </span>
              <span className="tabular text-muted">{r.actual ?? "—"}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-muted">
          Even when all hold, you still confirm + sign before any order.
        </p>
      </div>

      {formError ? <ErrorNote message={formError} /> : null}
      {createError ? <ErrorNote message={createError} /> : null}
      {create.isSuccess ? (
        <p className="text-xs text-pos">
          Rule created — it’s now watching the market. See the Smart Orders tab.
        </p>
      ) : null}

      <Button className="w-full" onClick={submit} disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create conditional rule"}
      </Button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-muted">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="tabular mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-fg outline-none focus:border-accent/50"
      />
    </label>
  );
}
