"use client";

/**
 * The strategy builder: template-first entry, node canvas, plain-English
 * sentence, live "Would trigger now?" state, and gated save/arm. Public
 * playground — everything works signed-out except saving.
 */
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Sparkles } from "lucide-react";
import { Badge, Button, Segmented, Skeleton, cn } from "@/components/ui";
import { useSession, useSignIn } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import {
  useFeatureFlags,
  useMarketEconomics,
  useMarketScenarios,
  useShowcases,
} from "@/lib/queries";
import { signedUsd } from "@/lib/format";
import {
  UNBOUND,
  conditionLeavesOf,
  docFromDefinition,
  docMarketRefs,
  type StrategyDoc,
} from "@/lib/strategies/doc";
import { listDraftsLocal, markDraftConsumedLocal } from "@/lib/strategies/drafts";
import { saveLimitPrefs } from "@/lib/strategies/limit-prefs";
import { importServerDrafts, markDraftConsumedOnServer } from "@/lib/strategies/drafts-sync";
import { computePayoff, payoffInputFromDoc } from "@/lib/strategies/projection";
import { compileDoc, validateDoc } from "@/lib/strategies/compile";
import { layoutDoc } from "@/lib/strategies/layout";
import { useBuilderStore } from "@/lib/strategies/store";
import { useDraftAutosave } from "@/lib/strategies/use-draft-autosave";
import {
  useAutoReadiness,
  useCreateStrategy,
  useDraftEvaluation,
  useStrategy,
} from "@/lib/strategies/queries";
import { TEMPLATES, templateById } from "@/lib/strategies/templates";
import {
  loadCanvasHeight,
  saveCanvasHeight,
  DEFAULT_CANVAS_HEIGHT,
  type CanvasHeight,
} from "@/lib/strategies/builder-view";
import { isComplexDoc } from "@/lib/strategies/grid-projection";
import { BuilderTour } from "@/components/onboarding/tours";
import { StrategyGrid } from "@/components/strategies/grid/StrategyGrid";
import { GridComposer } from "@/components/strategies/grid/GridComposer";
import { CanvasStrip } from "@/components/strategies/grid/CanvasStrip";
import { ArmSheet } from "@/components/strategies/ArmSheet";
import { DraftSwitcher } from "./DraftSwitcher";
import { SentenceBar } from "./SentenceBar";

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

  // The canvas is always on screen under the grid; this only remembers how
  // tall the user keeps it. Loaded after mount so SSR matches the default.
  const [canvasHeight, setCanvasHeightState] = useState<CanvasHeight>(DEFAULT_CANVAS_HEIGHT);
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => setCanvasHeightState(loadCanvasHeight()), []);
  const setCanvasHeight = (h: CanvasHeight) => {
    setCanvasHeightState(h);
    saveCanvasHeight(h);
  };
  /** Expand the strip and bring it into view (complex-logic escape hatch). */
  const openCanvas = () => {
    setCanvasHeight("tall");
    requestAnimationFrame(() =>
      canvasRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" }),
    );
  };
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
    start: params.get("start"),
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
        routerRef.current.replace(`/strategies/new?draft=${draftId}`, { scroll: false });
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
    if (entry.start === "blank") {
      // Start blank (brief §8.1.6/7): an empty canvas the user builds up
      // market → condition → action → execution via the Add-a-block palette,
      // rather than a pre-filled template.
      finish(spawnDraft(undefined, { origin: "blank" }));
      return;
    }
    const explicitTemplate = Boolean(entry.template || (entry.tokenId && entry.conditionId));
    if (!explicitTemplate) {
      // Bare /strategies/new: keep this session's live canvas, else resume
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

  // Markets the canvas shows but the expression doesn't reference (order
  // action / watched) still need live freshness — otherwise their nodes sit
  // on "waiting for data…" forever.
  const extraTokenIds = useMemo(() => {
    const exprTokens = new Set(
      conditionLeavesOf(doc.expr).flatMap((l) =>
        l.condition.kind !== "time_window" ? [l.condition.market.tokenId] : [],
      ),
    );
    return docMarketRefs(doc)
      .map((r) => r.tokenId)
      .filter((t) => t !== "" && !exprTokens.has(t))
      .slice(0, 8);
  }, [doc]);

  const debouncedRevision = useDebouncedRevision(revision);
  const evaluation = useDraftEvaluation(
    hasConditions && boundTokens ? doc.expr : null,
    doc.maxDataAgeMs,
    extraTokenIds,
    debouncedRevision,
    initialized,
  );

  const signedIn = Boolean(session.data);
  const autoReadiness = useAutoReadiness(signedIn);
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
  // version), so "editing" = create the new version superseding the old one —
  // the SERVER does both in one transaction (create + cancel + link + carry
  // spend caps), closing the old client-side create-then-cancel race where a
  // crash between the two calls left both strategies armed.
  // The consumed draft is tombstoned (linked to the created strategy) and the
  // canvas moves to a fresh blank draft, so returning to the builder doesn't
  // resurrect already-armed work.
  /**
   * A strategy places exactly ONE order (StrategyDefinition.action is a single
   * ActionV2 and the trigger→sign→submit path is one order per trigger), so
   * "trade a second market on these conditions" is a second strategy. This
   * forks the current doc into a fresh draft with the same conditions and an
   * unbound target, which is the honest, engine-shaped way to express it.
   */
  const duplicateForMarket = () => {
    const source = useBuilderStore.getState().doc;
    if (source.action.kind !== "order") return;
    const next: StrategyDoc = {
      ...source,
      name: source.name ? `${source.name} (2nd market)` : "",
      action: { ...source.action, market: UNBOUND },
      selectedNodeId: "action",
    };
    const id = spawnDraft(next, { origin: "duplicate" });
    if (!editOf) router.replace(`/strategies/new?draft=${id}`, { scroll: false });
  };

  // Arm flow: the save button opens the activation sheet (execution mode +
  // notifications + recurrence live there); the sheet's Arm button runs this
  // mutation — the create/supersede path itself is unchanged.
  const [armOpen, setArmOpen] = useState(false);
  const save = () => {
    // Read FRESH state: the arm sheet may have just adopted the suggested name
    // in the same tick, and a stale closure would arm the unnamed doc.
    const current = useBuilderStore.getState().doc;
    create.mutate(
      { ...compileDoc(current), ...(editOf ? { supersedes: editOf } : {}) },
      {
        onSuccess: (created) => {
          // Remember the armed caps so the next auto strategy starts prefilled.
          if (doc.action.kind === "order" && doc.action.execution === "auto") {
            saveLimitPrefs(doc.limits);
          }
          const consumedId = useBuilderStore.getState().draftId;
          useBuilderStore.getState().spawnDraft();
          if (consumedId) {
            markDraftConsumedLocal(consumedId, created.id);
            void markDraftConsumedOnServer(consumedId, created.id);
          }
          setArmOpen(false);
          router.push("/strategies");
        },
      },
    );
  };

  const saveError =
    create.error instanceof ApiError
      ? create.error.message
      : create.error instanceof Error
        ? create.error.message
        : null;

  // The save/arm card — rendered in the WorkspacePanel footer (canvas view)
  // or under the ACT column (grid view). One JSX source, both views.
  const saveFooter = (
    <div
      className="space-y-2 rounded-xl border border-border bg-surface p-4 shadow-panel"
      data-tour="builder-save"
    >
      {signedIn ? (
        <>
          <Button className="w-full" disabled={!canSave} onClick={() => setArmOpen(true)}>
            <Sparkles size={14} aria-hidden />
            {create.isPending ? "Arming…" : "Arm — start watching"}
          </Button>
          <p className="text-[11px] leading-snug text-muted">
            Arming just starts watching — nothing is bought until you approve it.
          </p>
          {saveError ? <p className="text-[12px] text-neg">{saveError}</p> : null}
        </>
      ) : (
        <>
          <Button className="w-full" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
            {signIn.isPending ? "Check your wallet…" : "Sign in to save"}
          </Button>
          <p className="text-[11px] leading-snug text-muted">
            Building and simulating is free — no account needed until you save.
          </p>
          {signIn.error instanceof Error ? (
            <p className="text-[12px] text-neg">{signIn.error.message}</p>
          ) : null}
        </>
      )}
    </div>
  );

  // Validation checklist — shared by both views.
  const checklist =
    issues.length > 0 ? (
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
    );

  return (
    <div className="space-y-3">
      {/* Header row: name, templates, save */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={doc.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name your strategy…"
          className="min-w-[220px] flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg font-semibold tracking-tight text-fg outline-none transition-colors placeholder:text-faint hover:border-border focus:border-brand"
          aria-label="Strategy name"
        />
        <div className="no-scrollbar flex min-w-0 max-w-full items-center gap-2 overflow-x-auto">
          <DraftSwitcher
            onOpenDraft={(id) => {
              if (!editOf) router.replace(`/strategies/new?draft=${id}`, { scroll: false });
            }}
          />
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                // Spawn (not reset): edited work survives as its own draft.
                const id = spawnDraft(t.build(), { origin: `template:${t.id}` });
                if (!editOf) router.replace(`/strategies/new?draft=${id}`, { scroll: false });
              }}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
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

      {isComplexDoc(doc) ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-warn/30 bg-warn/5 px-3.5 py-2 text-[12px] text-warn">
          <span>
            Part of this strategy uses grouped logic the grid shows read-only — rewire it on the
            canvas below.
          </span>
          <button
            type="button"
            onClick={openCanvas}
            className="shrink-0 font-semibold text-warn underline-offset-2 hover:underline"
          >
            Show me
          </button>
        </div>
      ) : null}

      <StrategyGrid
        doc={doc}
        edit
        evaluation={evaluation.data}
        liveReceivedAtMs={evaluation.dataUpdatedAt || undefined}
        onOpenCanvas={openCanvas}
        onDuplicateForMarket={duplicateForMarket}
        actFooter={
          <div className="space-y-3">
            {checklist}
            {saveFooter}
          </div>
        }
      />

      <CanvasStrip
        ref={canvasRef}
        height={canvasHeight}
        onHeightChange={setCanvasHeight}
        evaluation={evaluation.data}
        issues={issues}
      />

      {flags.data?.aiChat ? (
        <GridComposer initialPrompt={aiPrompt} initialPinned={initialPinned} />
      ) : null}

      <ArmSheet
        open={armOpen}
        onClose={() => setArmOpen(false)}
        onArm={save}
        arming={create.isPending}
        saveError={saveError}
        autoReadiness={autoReadiness.data}
      />
    </div>
  );
}
