"use client";

/**
 * The Smart Order builder: template-first entry, node canvas, plain-English
 * sentence, live "Would trigger now?" state, and gated save/arm. Public
 * playground — everything works signed-out except saving.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Sparkles } from "lucide-react";
import { Badge, Button, Skeleton, cn } from "@/components/ui";
import { useSession, useSignIn } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import {
  useFeatureFlags,
  useMarketEconomics,
  useMarketScenarios,
  useShowcases,
} from "@/lib/queries";
import { signedUsd } from "@/lib/format";
import { conditionLeavesOf, docFromDefinition } from "@/lib/smart-orders/doc";
import { listDraftsLocal, markDraftConsumedLocal } from "@/lib/smart-orders/drafts";
import { importServerDrafts, markDraftConsumedOnServer } from "@/lib/smart-orders/drafts-sync";
import { computePayoff, payoffInputFromDoc } from "@/lib/smart-orders/projection";
import { compileDoc, validateDoc } from "@/lib/smart-orders/compile";
import { layoutDoc } from "@/lib/smart-orders/layout";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useDraftAutosave } from "@/lib/smart-orders/use-draft-autosave";
import {
  useCreateStrategy,
  useDraftEvaluation,
  useStrategy,
  useStrategyControl,
} from "@/lib/smart-orders/queries";
import { TEMPLATES, templateById } from "@/lib/smart-orders/templates";
import { usePanelWidth } from "@/lib/use-panel-width";
import { BuilderTour } from "@/components/onboarding/tours";
import { AddPalette } from "./AddPalette";
import { CanvasToolbar } from "./CanvasToolbar";
import { DraftSwitcher } from "./DraftSwitcher";
import { CANVAS_HEIGHT_CLASS } from "./layout-constants";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { SentenceBar } from "./SentenceBar";
import { WorkspacePanel } from "./WorkspacePanel";

const BuilderCanvas = dynamic(() => import("./BuilderCanvas"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-xl" />,
});

/**
 * Parse ?pinned= — comma-separated `conditionId~encodedTitle` entries, capped
 * at 4 (the API's pinnedConditionIds limit). Malformed entries are dropped.
 */
export function parsePinnedParam(raw: string | null): { conditionId: string; title: string }[] {
  if (!raw) return [];
  const out: { conditionId: string; title: string }[] = [];
  for (const entry of raw.split(",")) {
    if (out.length >= 4) break;
    const sep = entry.indexOf("~");
    if (sep <= 0 || sep === entry.length - 1) continue;
    try {
      const title = decodeURIComponent(entry.slice(sep + 1));
      if (title.trim().length === 0) continue;
      out.push({ conditionId: entry.slice(0, sep), title });
    } catch {
      // Broken percent-encoding — drop the entry.
    }
  }
  return out;
}

/** Debounce the store revision so draft evaluation isn't spammed per keystroke. */
function useDebouncedRevision(revision: number, delayMs = 1_200): number {
  const [debounced, setDebounced] = useState(revision);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(revision), delayMs);
    return () => clearTimeout(t);
  }, [revision, delayMs]);
  return debounced;
}

function WouldTriggerNow({
  satisfied,
  stale,
  hasConditions,
  loading,
  projection,
}: {
  satisfied: boolean;
  stale: boolean;
  hasConditions: boolean;
  loading: boolean;
  projection: { text: string; positive: boolean } | null;
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
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3.5 py-2.5 shadow-panel">
      <span className="text-[13px] font-medium text-fg">Would trigger now?</span>
      <div className="flex items-center gap-2">
        {projection ? (
          <span
            className={cn(
              "tabular text-[12px] font-semibold",
              projection.positive ? "text-pos" : "text-neg",
            )}
          >
            {projection.text}
          </span>
        ) : null}
        <Badge tone={tone === "neutral" ? "neutral" : tone} dot={tone === "pos"}>
          {label}
        </Badge>
      </div>
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
  const spawnDraft = useBuilderStore((s) => s.spawnDraft);
  const loadDraft = useBuilderStore((s) => s.loadDraft);
  const setName = useBuilderStore((s) => s.setName);
  const setActiveTab = useBuilderStore((s) => s.setActiveTab);

  const [initialized, setInitialized] = useState(false);
  // Ref twin of `initialized`: store updates inside the init effect force a
  // synchronous re-render before the state update flushes, so the state guard
  // alone can re-enter the effect. The ref closes that window.
  const initializedRef = useRef(false);
  const routerRef = useRef(router);
  routerRef.current = router;
  const panel = usePanelWidth();
  useDraftAutosave();
  // Pull the account's drafts into localStorage once per mount (fail-soft when
  // signed out) — cross-device drafts then show up in the switcher/resume.
  useEffect(() => {
    void importServerDrafts();
  }, []);

  // Entry params are captured once per mount: after the entry is consumed the
  // URL is rewritten to the canonical ?draft=<id> form, and captured values
  // keep the deep-link props (AI prompt, pins) stable through that replace.
  const [entry] = useState(() => ({
    draft: params.get("draft"),
    template: params.get("template"),
    prompt: params.get("prompt"),
    pinned: params.get("pinned"),
    showcase: params.get("showcase"),
    scenario: params.get("scenario"),
    scenarioMarket: params.get("scenarioMarket"),
    outcome: params.get("outcome"),
    tokenId: params.get("tokenId"),
    conditionId: params.get("conditionId"),
    title: params.get("title"),
    size: params.get("size"),
  }));

  const flags = useFeatureFlags();
  const aiPrompt = entry.prompt;
  const initialPinned = useMemo(() => parsePinnedParam(entry.pinned), [entry.pinned]);
  const showcaseId = entry.showcase;
  const showcases = useShowcases(Boolean(showcaseId));
  const scenarioId = entry.scenario;
  const scenarioMarket = entry.scenarioMarket;
  const scenarioOutcome = Number(entry.outcome ?? "0");
  const scenarios = useMarketScenarios(
    scenarioMarket ?? "",
    Number.isFinite(scenarioOutcome) ? scenarioOutcome : 0,
    Boolean(scenarioMarket && scenarioId),
  );

  // Entry modes: resume a draft (?draft=…), edit an existing strategy, a
  // backtested showcase deep link (?showcase=…), a cockpit entry-scenario deep
  // link (?scenarioMarket=&scenario=…), AI prompt deep link (landing hero,
  // ?prompt=…), or template-first creation. A ?conditionId=&tokenId=&outcome=
  // &title= set pre-binds the template to a market (the cockpit's deep link).
  //
  // Every path SPAWNS a draft instead of resetting in place: in-progress work
  // is flushed to its own draft first, so no preset/AI/deep-link entry can
  // overwrite a custom strategy. The URL is then canonicalized to ?draft=<id>
  // so remounts resume the same draft instead of re-running the entry.
  useEffect(() => {
    if (initializedRef.current) return;
    const finish = (draftId?: string) => {
      initializedRef.current = true;
      setInitialized(true);
      if (draftId && !editOf) {
        routerRef.current.replace(`/smart-orders/new?draft=${draftId}`, { scroll: false });
      }
    };
    if (entry.draft && !editOf) {
      if (useBuilderStore.getState().draftId === entry.draft || loadDraft(entry.draft)) {
        finish();
        return;
      }
      // Unknown/evicted draft id → fall through to the default path.
    }
    if (editOf) {
      // Resume an in-progress edit of this strategy, else seed a stable
      // per-strategy draft slot from its (immutable) definition.
      if (loadDraft(`edit-${editOf}`)) {
        finish();
        return;
      }
      if (!editing.data) return; // wait for the strategy to load
      spawnDraft(layoutDoc(docFromDefinition(editing.data.definitionV2)), {
        id: `edit-${editOf}`,
        origin: `edit:${editOf}`,
      });
      finish();
      return;
    }
    if (showcaseId) {
      if (showcases.isLoading) return; // wait for the showcase list
      const sc = showcases.data?.showcases.find((s) => s.id === showcaseId);
      if (sc) {
        const next = layoutDoc(docFromDefinition(sc.definition));
        next.marketMeta = {
          [sc.market.tokenId]: {
            title: sc.market.title,
            ...(sc.market.image ? { image: sc.market.image } : {}),
            rewardsMinSize: null,
            rewardsMaxSpread: null,
          },
        };
        finish(spawnDraft(next, { origin: `showcase:${sc.id}` }));
        return;
      }
      // Unknown/expired showcase id → fall through to the template path.
    }
    if (scenarioMarket && scenarioId) {
      if (scenarios.isLoading) return; // wait for the per-market scenario list
      const sc = scenarios.data?.scenarios.find((s) => s.id === scenarioId);
      if (sc) {
        finish(
          spawnDraft(layoutDoc(docFromDefinition(sc.definition)), {
            origin: `scenario:${sc.id}`,
          }),
        );
        return;
      }
      // Unknown/expired scenario id → fall through to the template path.
    }
    if (aiPrompt) {
      if (flags.isLoading) return; // wait to know whether the AI panel exists
      if (flags.data?.aiChat) {
        // Start blank — the AiPanel auto-fires the prompt and fills the canvas.
        // The tab store survives navigation, so force the AI tab into view.
        const id = spawnDraft(undefined, { origin: "ai" });
        setActiveTab("ai");
        finish(id);
        return;
      }
      // Flag off → fall through to the template path (graceful degradation).
    }
    const explicitTemplate = Boolean(entry.template || (entry.tokenId && entry.conditionId));
    if (!explicitTemplate) {
      // Bare /smart-orders/new: keep this session's live canvas, else resume
      // the most recent draft. A first-ever visit falls through to the
      // default template scaffold.
      const live = useBuilderStore.getState().draftId;
      if (live) {
        finish(live);
        return;
      }
      const recent = listDraftsLocal()[0];
      if (recent && loadDraft(recent.id)) {
        finish(recent.id);
        return;
      }
    }
    const template = (entry.template ? templateById(entry.template) : null) ?? TEMPLATES[0]!;
    const market =
      entry.tokenId && entry.conditionId
        ? {
            conditionId: entry.conditionId,
            tokenId: entry.tokenId,
            outcome: entry.outcome ?? "YES",
            ...(entry.title ? { title: entry.title } : {}),
          }
        : undefined;
    const meta = entry.title ? { title: entry.title } : undefined;
    const doc = template.build(market, meta);
    // ?size= (portfolio "Protect this position"): size the prepared order to
    // the caller's actual position instead of the template default.
    const sizeParam = Number(entry.size);
    if (doc.action.kind === "order" && Number.isFinite(sizeParam) && sizeParam >= 1) {
      doc.action = { ...doc.action, size: Math.round(sizeParam) };
    }
    finish(spawnDraft(doc, { origin: `template:${template.id}` }));
  }, [
    initialized,
    entry,
    spawnDraft,
    loadDraft,
    setActiveTab,
    editOf,
    editing.data,
    aiPrompt,
    flags.isLoading,
    flags.data,
    showcaseId,
    showcases.isLoading,
    showcases.data,
    scenarioId,
    scenarioMarket,
    scenarios.isLoading,
    scenarios.data,
  ]);

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

  // Headline payoff next to the verdict — the number the owner wants seen
  // first ("how much can this make me?"). Estimates only; taker entries
  // subtract the market's taker fee when the schedule is known.
  const takerOrderConditionId =
    doc.action.kind === "order" &&
    (doc.action.orderType === "FOK" || doc.action.orderType === "FAK")
      ? doc.action.market.conditionId
      : "";
  const headlineEconomics = useMarketEconomics(takerOrderConditionId);
  const projection = useMemo(() => {
    const input = payoffInputFromDoc(doc, evaluation.data?.markets ?? []);
    if (!input) return null;
    const p = computePayoff({
      ...input,
      feeSchedule: headlineEconomics.data?.feeSchedule ?? null,
    });
    return {
      text: `Projected: ${signedUsd(p.payoffIfWinUsd)} if ${input.outcome || "YES"} wins`,
      positive: p.payoffIfWinUsd >= 0,
    };
  }, [doc, evaluation.data, headlineEconomics.data]);

  // Definitions are immutable once armed (evidence stays tied to the exact
  // version), so "editing" = create the new version, then cancel the old one.
  // The consumed draft is tombstoned (linked to the created strategy) and the
  // canvas moves to a fresh blank draft, so returning to the builder doesn't
  // resurrect already-armed work.
  const save = () => {
    create.mutate(compileDoc(doc), {
      onSuccess: (created) => {
        const consumedId = useBuilderStore.getState().draftId;
        useBuilderStore.getState().spawnDraft();
        if (consumedId) {
          markDraftConsumedLocal(consumedId, created.id);
          void markDraftConsumedOnServer(consumedId, created.id);
        }
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
          <DraftSwitcher
            onOpenDraft={(id) => {
              if (!editOf) router.replace(`/smart-orders/new?draft=${id}`, { scroll: false });
            }}
          />
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                // Spawn (not reset): edited work survives as its own draft.
                const id = spawnDraft(t.build(), { origin: `template:${t.id}` });
                if (!editOf) router.replace(`/smart-orders/new?draft=${id}`, { scroll: false });
              }}
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

      <BuilderTour />
      <SentenceBar />
      <WouldTriggerNow
        satisfied={Boolean(evaluation.data?.satisfied)}
        stale={(evaluation.data?.staleTokenIds.length ?? 0) > 0}
        hasConditions={hasConditions && boundTokens}
        loading={evaluation.isLoading}
        projection={projection}
      />

      <div
        className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto_var(--panel-w)] lg:gap-1"
        style={{ ["--panel-w" as string]: `${panel.width}px` }}
      >
        <div className="min-w-0 space-y-2">
          <CanvasToolbar />
          <div className={cn("relative", CANVAS_HEIGHT_CLASS)}>
            <BuilderCanvas evaluation={evaluation.data} issues={issues} />
            <AddPalette />
          </div>

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

        <PanelResizeHandle
          width={panel.width}
          dragging={panel.dragging}
          onPointerDown={panel.startDrag}
          onKeyDown={panel.onKeyDown}
          className="hidden lg:block"
        />

        <WorkspacePanel
          evaluation={evaluation.data}
          aiChatEnabled={Boolean(flags.data?.aiChat)}
          aiPrompt={aiPrompt}
          aiPinned={initialPinned}
          footer={
            <div
              className="space-y-2 rounded-xl border border-border bg-surface p-4 shadow-panel"
              data-tour="builder-save"
            >
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
          }
        />
      </div>
    </div>
  );
}
