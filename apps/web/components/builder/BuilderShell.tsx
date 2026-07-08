"use client";

/**
 * The Smart Order builder: template-first entry, node canvas, plain-English
 * sentence, live "Would trigger now?" state, and gated save/arm. Public
 * playground — everything works signed-out except saving.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Plus, Sparkles } from "lucide-react";
import type { ConditionV2 } from "@mx2/rules";
import { Badge, Button, Skeleton, cn } from "@/components/ui";
import { useSession, useSignIn } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { UNBOUND, conditionLeavesOf, docFromDefinition } from "@/lib/smart-orders/doc";
import { compileDoc, validateDoc } from "@/lib/smart-orders/compile";
import { layoutDoc } from "@/lib/smart-orders/layout";
import { useBuilderStore } from "@/lib/smart-orders/store";
import {
  useCreateStrategy,
  useDraftEvaluation,
  useStrategy,
  useStrategyControl,
} from "@/lib/smart-orders/queries";
import { TEMPLATES, templateById } from "@/lib/smart-orders/templates";
import { Inspector } from "./Inspector";
import { MakerEstimator } from "./MakerEstimator";
import { SentenceBar } from "./SentenceBar";

const BuilderCanvas = dynamic(() => import("./BuilderCanvas"), {
  ssr: false,
  loading: () => <Skeleton className="h-[520px] w-full rounded-xl" />,
});

/** Debounce the store revision so draft evaluation isn't spammed per keystroke. */
function useDebouncedRevision(revision: number, delayMs = 1_200): number {
  const [debounced, setDebounced] = useState(revision);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(revision), delayMs);
    return () => clearTimeout(t);
  }, [revision, delayMs]);
  return debounced;
}

const CONDITION_MENU: { label: string; make: () => ConditionV2 }[] = [
  {
    label: "Price above / below",
    make: () => ({
      kind: "price",
      market: UNBOUND,
      source: "ask",
      comparator: "lte",
      threshold: 0.5,
    }),
  },
  {
    label: "Spread tightness",
    make: () => ({ kind: "spread", market: UNBOUND, comparator: "lte", threshold: 0.02 }),
  },
  {
    label: "Liquidity at least",
    make: () => ({
      kind: "cumulative_notional",
      market: UNBOUND,
      source: "ask",
      priceBound: 0.5,
      minNotional: 1000,
    }),
  },
  {
    label: "Visible book levels",
    make: () => ({
      kind: "visible_levels",
      market: UNBOUND,
      source: "ask",
      priceBound: 0.5,
      minLevels: 3,
    }),
  },
  {
    label: "Time window",
    make: () => ({ kind: "time_window", startMs: null, endMs: null }),
  },
];

function WouldTriggerNow({
  satisfied,
  stale,
  hasConditions,
  loading,
}: {
  satisfied: boolean;
  stale: boolean;
  hasConditions: boolean;
  loading: boolean;
}) {
  if (!hasConditions) return null;
  const [label, tone]: [string, "pos" | "warn" | "neutral"] = loading
    ? ["Checking…", "neutral"]
    : satisfied
      ? ["Yes — all conditions hold right now", "pos"]
      : stale
        ? ["Waiting for fresh market data", "warn"]
        : ["Not yet", "neutral"];
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-surface px-3.5 py-2.5 shadow-panel">
      <span className="text-[13px] font-medium text-fg">Would trigger now?</span>
      <Badge tone={tone === "neutral" ? "neutral" : tone} dot={tone === "pos"}>
        {label}
      </Badge>
    </div>
  );
}

export function BuilderShell({ editOf }: { editOf?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const signIn = useSignIn();
  const create = useCreateStrategy();
  const control = useStrategyControl();
  const editing = useStrategy(editOf ?? null);

  const doc = useBuilderStore((s) => s.doc);
  const revision = useBuilderStore((s) => s.revision);
  const reset = useBuilderStore((s) => s.reset);
  const setName = useBuilderStore((s) => s.setName);
  const addCondition = useBuilderStore((s) => s.addCondition);

  const [menuOpen, setMenuOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Entry modes: edit an existing strategy, or template-first creation.
  // A ?conditionId=&tokenId=&outcome=&title= set pre-binds the template to a
  // market (the cockpit's "Automate this market" deep link).
  useEffect(() => {
    if (initialized) return;
    if (editOf) {
      if (!editing.data) return; // wait for the strategy to load
      reset(layoutDoc(docFromDefinition(editing.data.definitionV2)));
      setInitialized(true);
      return;
    }
    const t = params.get("template");
    const template = (t ? templateById(t) : null) ?? TEMPLATES[0]!;
    const tokenId = params.get("tokenId");
    const conditionId = params.get("conditionId");
    const market =
      tokenId && conditionId
        ? {
            conditionId,
            tokenId,
            outcome: params.get("outcome") ?? "YES",
            ...(params.get("title") ? { title: params.get("title")! } : {}),
          }
        : undefined;
    const meta = params.get("title") ? { title: params.get("title")! } : undefined;
    reset(template.build(market, meta));
    setInitialized(true);
  }, [initialized, params, reset, editOf, editing.data]);

  const issues = useMemo(() => validateDoc(doc), [doc]);
  const hasConditions = conditionLeavesOf(doc.expr).length > 0;
  const boundTokens = useMemo(
    () =>
      conditionLeavesOf(doc.expr).some(
        (l) => l.condition.kind !== "time_window" && l.condition.market.tokenId !== "",
      ),
    [doc],
  );

  const debouncedRevision = useDebouncedRevision(revision);
  const evaluation = useDraftEvaluation(
    hasConditions && boundTokens ? doc.expr : null,
    doc.maxDataAgeMs,
    debouncedRevision,
    initialized,
  );

  const signedIn = Boolean(session.data);
  const allowlisted = Boolean(session.data?.allowlisted);
  const canSave = issues.length === 0 && !create.isPending;

  // Definitions are immutable once armed (evidence stays tied to the exact
  // version), so "editing" = create the new version, then cancel the old one.
  const save = () => {
    create.mutate(compileDoc(doc), {
      onSuccess: () => {
        if (editOf) control.mutate({ id: editOf, action: "cancel" });
        router.push("/smart-orders");
      },
    });
  };

  const saveError =
    create.error instanceof ApiError
      ? create.error.message
      : create.error instanceof Error
        ? create.error.message
        : null;

  return (
    <div className="space-y-3">
      {/* Header row: name, templates, save */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={doc.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name your Smart Order…"
          className="min-w-[220px] flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg font-semibold tracking-tight text-fg outline-none transition-colors placeholder:text-faint hover:border-border focus:border-brand"
          aria-label="Strategy name"
        />
        <div className="flex items-center gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => reset(t.build())}
              className={cn(
                "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
                doc.templateId === t.id
                  ? "border-brand/50 bg-brand-soft text-accent"
                  : "border-border bg-surface text-muted hover:text-fg",
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <SentenceBar />
      <WouldTriggerNow
        satisfied={Boolean(evaluation.data?.satisfied)}
        stale={(evaluation.data?.staleTokenIds.length ?? 0) > 0}
        hasConditions={hasConditions && boundTokens}
        loading={evaluation.isLoading}
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
        <div className="space-y-2">
          {/* Toolbar: add-condition palette */}
          <div className="relative flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setMenuOpen((o) => !o)}>
              <Plus size={13} aria-hidden /> Add condition
            </Button>
            <span className="text-[11px] text-faint">
              drag blocks to arrange · click a block to edit it
            </span>
            {menuOpen ? (
              <div className="absolute left-0 top-full z-20 mt-1.5 w-56 space-y-0.5 rounded-lg border border-border bg-surface p-1.5 shadow-pop">
                {CONDITION_MENU.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      addCondition(item.make());
                      setMenuOpen(false);
                    }}
                    className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg transition-colors hover:bg-surface-2"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <BuilderCanvas evaluation={evaluation.data} issues={issues} />

          {/* Validation checklist */}
          {issues.length > 0 ? (
            <ul className="space-y-1 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5">
              {issues.slice(0, 4).map((issue, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[12px] text-muted">
                  <CircleAlert size={12} className="shrink-0 text-warn" aria-hidden />
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-center gap-1.5 rounded-xl border border-pos/30 bg-pos/5 px-3.5 py-2.5 text-[12px] text-pos">
              <CheckCircle2 size={13} aria-hidden /> Ready to save
            </div>
          )}
        </div>

        <div className="space-y-3">
          <Inspector />
          <MakerEstimator evaluation={evaluation.data} />

          {/* Save / arm */}
          <div className="space-y-2 rounded-xl border border-border bg-surface p-4 shadow-panel">
            {signedIn ? (
              allowlisted ? (
                <>
                  <Button className="w-full" disabled={!canSave} onClick={save}>
                    <Sparkles size={14} aria-hidden />
                    {create.isPending ? "Saving…" : "Save & start watching"}
                  </Button>
                  {doc.action.kind === "order" && doc.action.execution === "auto" ? (
                    <p className="text-[11px] leading-snug text-muted">
                      Auto mode places orders from your{" "}
                      <Link href="/wallet" className="text-accent hover:underline">
                        Arima trading wallet
                      </Link>{" "}
                      within the limits above. If the wallet isn&apos;t ready, triggers wait for
                      your signature instead.
                    </p>
                  ) : null}
                  {saveError ? <p className="text-[12px] text-neg">{saveError}</p> : null}
                </>
              ) : (
                <p className="text-[12px] leading-snug text-muted">
                  Your account isn&apos;t in the beta yet — you can build and simulate freely, and
                  save once you have access.
                </p>
              )
            ) : (
              <>
                <Button
                  className="w-full"
                  onClick={() => signIn.mutate()}
                  disabled={signIn.isPending}
                >
                  {signIn.isPending ? "Check your wallet…" : "Sign in to save"}
                </Button>
                <p className="text-[11px] leading-snug text-muted">
                  Building and simulating is free — no account needed until you save.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
