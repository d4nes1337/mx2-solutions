"use client";

/**
 * Action editor — the strategy's single "then do this" block, for both the
 * panel Block tab and the expanded canvas node. Handles ALL four engine action
 * kinds (alert / order / stop_strategy / quote_loop). The kind selector
 * converts explicitly with a discard confirmation, and the alert vs order
 * split is a kind decision — so switching execution can never silently
 * clobber a farming loop or a stop link (the old data-loss bug).
 *
 * The dense per-kind forms live in OrderActionEditor / QuoteLoopEditor; this
 * file owns kind selection and the shared canvas-node editors.
 */
import { useState } from "react";
import type { ActionV2 } from "@mx2/rules";
import { Button, Segmented } from "@/components/ui";
import { UNBOUND } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useFeatureFlags } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { useStrategies } from "@/lib/smart-orders/queries";
import { CONDITION_KIND_OPTIONS, defaultCondition } from "./ConditionEditor";
import { Field } from "./fields";
import { OrderActionEditor } from "./OrderActionEditor";
import { QuoteLoopForm } from "./QuoteLoopEditor";

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

      {a.kind === "order" ? <OrderActionEditor action={a} /> : null}
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
