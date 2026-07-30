"use client";

/**
 * Action editor — the strategy's single "then do this" block, for both the
 * panel Block tab and the expanded canvas node. Handles ALL four engine action
 * kinds (alert / order / stop_strategy / quote_loop).
 *
 * The primary picker is ONE user-facing choice in execution order: sign it
 * yourself (order+prepare, the default) → Arima wallet (order+auto) → alert
 * only. Stop-strategy and farming live under Advanced. Any switch that would
 * lose configured settings still goes through the discard confirmation — so
 * changing execution can never silently clobber a farming loop or a stop link
 * (the old data-loss bug).
 *
 * The dense per-kind forms live in OrderActionEditor / QuoteLoopEditor; this
 * file owns action selection and the shared canvas-node editors.
 */
import { useState } from "react";
import Link from "next/link";
import type { ActionV2, OrderActionV2 } from "@mx2/rules";
import { Button, Segmented } from "@/components/ui";
import { actionHasConfig, UNBOUND } from "@/lib/strategies/doc";
import { loadLimitPrefs } from "@/lib/strategies/limit-prefs";
import { useBuilderStore } from "@/lib/strategies/store";
import { useFeatureFlags } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { useStrategies } from "@/lib/strategies/queries";
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

/** The 3-way primary picker, in the owner-decided order. */
type PrimaryChoice = "sign" | "auto" | "alert";

const CHOICE_LABELS: Record<PrimaryChoice, string> = {
  sign: "Ask me to sign",
  auto: "Auto · Arima Wallet",
  alert: "Alert only",
};

const choiceOf = (a: ActionV2): PrimaryChoice | "" =>
  a.kind === "order"
    ? a.execution === "auto"
      ? "auto"
      : "sign"
    : a.kind === "alert"
      ? "alert"
      : "";

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

/** Seed the required auto caps from last-used values (or this order's cost). */
const DEFAULT_LIMIT_FROM_ORDER = (a: OrderActionV2) => {
  const perOrder = Math.max(1, Math.ceil(a.price * a.size));
  return {
    maxNotionalPerOrder: perOrder,
    maxDailyNotional: perOrder,
    maxTotalNotional: perOrder,
  };
};

export function ActionEditor() {
  const doc = useBuilderStore((s) => s.doc);
  const setAction = useBuilderStore((s) => s.setAction);
  const setLimits = useBuilderStore((s) => s.setLimits);
  const flags = useFeatureFlags();
  /** A confirmed-discard target: the exact action to apply + its label. */
  const [pending, setPending] = useState<{
    action: ActionV2;
    label: string;
    seedLimits?: boolean;
  } | null>(null);
  const a = doc.action;

  const makerLoop = Boolean(flags.data?.makerLoop);
  const advancedKind = a.kind === "stop_strategy" || a.kind === "quote_loop";
  // Advanced starts open when the current action lives there (an existing
  // stop/farm strategy opens with its form visible, nothing converted).
  const [advancedOpen, setAdvancedOpen] = useState(advancedKind);

  const seedAutoLimits = (order: OrderActionV2) => {
    // First switch to auto: seed the caps so arming isn't blocked on an empty
    // form. Still editable, still required, still validated.
    if (doc.limits === null) setLimits(loadLimitPrefs() ?? DEFAULT_LIMIT_FROM_ORDER(order));
  };

  const apply = (target: ActionV2, seedLimits: boolean) => {
    setAction(target);
    if (seedLimits && target.kind === "order") seedAutoLimits(target);
  };

  /** Cross-kind switch: confirm before discarding configured settings. */
  const request = (target: ActionV2, label: string, seedLimits = false) => {
    if (actionHasConfig(a)) {
      setPending({ action: target, label, seedLimits });
      return;
    }
    apply(target, seedLimits);
  };

  const choose = (choice: PrimaryChoice) => {
    if (choice === choiceOf(a)) return;
    if (choice === "sign") {
      // order↔order keeps every param — only the execution flips.
      if (a.kind === "order") return setAction({ ...a, execution: "prepare" });
      return request(defaultActionFor("order"), CHOICE_LABELS.sign);
    }
    if (choice === "auto") {
      if (a.kind === "order") {
        setAction({ ...a, execution: "auto" });
        return seedAutoLimits(a);
      }
      return request(
        { ...(defaultActionFor("order") as OrderActionV2), execution: "auto" },
        CHOICE_LABELS.auto,
        true,
      );
    }
    if (a.kind !== "alert") request({ kind: "alert" }, CHOICE_LABELS.alert);
  };

  const chooseAdvanced = (kind: "stop_strategy" | "quote_loop") => {
    if (a.kind === kind) return;
    request(defaultActionFor(kind), KIND_LABELS[kind]);
  };

  return (
    <div className="space-y-3">
      <Field label="When it triggers">
        <div className="nodrag">
          <Segmented
            options={[
              { value: "sign" as const, label: CHOICE_LABELS.sign },
              { value: "auto" as const, label: CHOICE_LABELS.auto },
              { value: "alert" as const, label: CHOICE_LABELS.alert },
            ]}
            value={choiceOf(a) as PrimaryChoice}
            onChange={choose}
            size="sm"
            grow
          />
        </div>
      </Field>

      {/* Per-choice one-liner so the trade-off is visible before committing. */}
      {a.kind === "order" && a.execution === "prepare" ? (
        <p className="text-[11px] leading-snug text-muted">
          You sign each triggered order in your connected wallet — the default.
        </p>
      ) : null}
      {a.kind === "order" && a.execution === "auto" ? (
        <p className="text-[11px] leading-snug text-muted">
          Executes automatically from your{" "}
          <Link href="/wallet" className="text-accent hover:underline">
            Arima Wallet (Beta)
          </Link>
          . Enable and fund it on the Wallet page — until then, triggers wait for your signature.
        </p>
      ) : null}
      {a.kind === "alert" ? (
        <p className="text-[12px] leading-snug text-muted">
          You&apos;ll get a notification with full trigger evidence — nothing trades.
        </p>
      ) : null}

      {pending ? (
        <div className="nodrag space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5">
          <p className="text-[12px] leading-snug text-warn">
            Switching to “{pending.label}” discards this action&apos;s current settings.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                apply(pending.action, pending.seedLimits ?? false);
                setPending(null);
              }}
            >
              Switch
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Keep current
            </Button>
          </div>
        </div>
      ) : null}

      {a.kind === "order" ? <OrderActionEditor action={a} /> : null}

      <details
        className="nodrag rounded-lg border border-border bg-surface-2 px-3 py-2"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary className="cursor-pointer text-[12px] font-medium text-muted">Advanced</summary>
        <div className="mt-2 space-y-3">
          <Field label="Other actions">
            <div className="nodrag">
              <Segmented
                options={[
                  { value: "stop_strategy" as const, label: KIND_LABELS.stop_strategy },
                  ...(makerLoop || a.kind === "quote_loop"
                    ? [{ value: "quote_loop" as const, label: KIND_LABELS.quote_loop }]
                    : []),
                ]}
                value={a.kind as "stop_strategy" | "quote_loop"}
                onChange={chooseAdvanced}
                size="sm"
                grow
              />
            </div>
          </Field>
          {a.kind === "stop_strategy" ? <StopStrategyForm targetId={a.targetStrategyId} /> : null}
          {a.kind === "quote_loop" ? <QuoteLoopForm action={a} makerLoop={makerLoop} /> : null}
          {!advancedKind ? (
            <p className="text-[10px] leading-snug text-faint">
              Stop another strategy when this one triggers, or run a maker rewards loop.
            </p>
          ) : null}
        </div>
      </details>
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
        Sign in to pick which of your strategies this one should stop.
      </p>
    );
  }
  return (
    <Field label="Strategy to stop">
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
