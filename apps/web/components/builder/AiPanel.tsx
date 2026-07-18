"use client";

/**
 * The AI tab: a full-height chat that turns typed ideas into a live strategy
 * canvas. Stateless server — the conversation lives in the builder store,
 * scoped to the current draft (switching drafts switches chats; a new draft
 * starts clean), and the recent turns are re-sent (plus the current compiled
 * definition) each time so follow-ups like "make it $200" refine in place.
 *
 * Display log vs API history: `aiMessages` is what the user sees (optimistic —
 * the user turn appears immediately); `aiHistory` is the exact API contract
 * (pushed only on success, capped) so a failed request never poisons the
 * next one.
 */
import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";
import { Badge, Spinner } from "@/components/ui";
import { Markdown } from "@/components/ui/Markdown";
import { ApiError } from "@/lib/api";
import { useGenerateStrategy, type AiGenerateResponse } from "@/lib/ai/queries";
import { conditionLeavesOf, docFromDefinition, docHasContent } from "@/lib/smart-orders/doc";
import { compileDoc } from "@/lib/smart-orders/compile";
import { layoutDoc } from "@/lib/smart-orders/layout";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useMarketMention } from "@/lib/smart-orders/use-mention";
import { TEMPLATES } from "@/lib/smart-orders/templates";
import { useAutogrowTextarea } from "@/lib/use-autogrow";
import { MentionDropdown } from "./MentionDropdown";

/** Progress theater: honest-ish stage copy while the model works. */
const STAGES = [
  "Reading your idea…",
  "Scanning live markets…",
  "Assembling conditions…",
  "Double-checking the logic…",
];
const STAGE_AT_MS = [0, 1_800, 5_000, 11_000];

export function AiPanel({
  initialPrompt,
  initialPinned,
}: {
  initialPrompt?: string | null;
  /** Deep-link pins (?pinned=) — seeded before the auto-fired prompt submits. */
  initialPinned?: { conditionId: string; title: string }[];
}) {
  const doc = useBuilderStore((s) => s.doc);
  const reset = useBuilderStore((s) => s.reset);
  const spawnDraft = useBuilderStore((s) => s.spawnDraft);
  const revealAll = useBuilderStore((s) => s.revealAll);
  const setAiStatus = useBuilderStore((s) => s.setAiStatus);
  // Chat state lives in the store, scoped per draft: switching drafts switches
  // conversations, and a fresh draft always starts with a clean chat.
  const messages = useBuilderStore((s) => s.aiMessages);
  const pushMessage = useBuilderStore((s) => s.pushAiMessage);
  const pushHistory = useBuilderStore((s) => s.pushAiHistory);
  const generate = useGenerateStrategy();

  const [input, setInput] = useState("");
  const [stage, setStage] = useState(0);
  const autoFired = useRef(false);
  /** Last submitted prompt — powers the Retry button and deep-link error copy. */
  const lastPrompt = useRef<{ text: string; fromDeepLink: boolean } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutogrowTextarea(textareaRef, input);
  const {
    mention,
    results: mentionResults,
    pick: pickMention,
    dismiss: dismissMention,
    syncFromCaret,
    pinned,
    unpin,
    seedPins,
  } = useMarketMention({ value: input, setValue: setInput, textareaRef });
  /** Keyboard cursor in the mention dropdown (arrows move, Enter picks). */
  const [mentionIndex, setMentionIndex] = useState(0);

  // Seed deep-link pins during the first render (render-phase state update):
  // the first committed render already has them, so the auto-fire effect's
  // submit closure sends pinnedConditionIds with the ?prompt= request.
  const seededRef = useRef(false);
  if (!seededRef.current && initialPinned && initialPinned.length > 0) {
    seededRef.current = true;
    seedPins(initialPinned);
  }

  const applyResult = (prompt: string, res: AiGenerateResponse) => {
    if (res.status === "clarify") {
      pushMessage({ role: "assistant", content: res.question });
      pushHistory([{ role: "user", content: prompt.slice(0, 600) }]);
      return;
    }
    const next = layoutDoc(docFromDefinition(res.definition));
    next.marketMeta = Object.fromEntries(
      Object.entries(res.markets).map(([tokenId, m]) => [
        tokenId,
        {
          title: m.title,
          ...(m.eventTitle !== undefined ? { eventTitle: m.eventTitle } : {}),
          ...(m.image !== undefined ? { image: m.image } : {}),
          rewardsMinSize: m.rewardsMinSize,
          rewardsMaxSpread: m.rewardsMaxSpread,
        },
      ]),
    );
    // First AI turn over a hand-edited canvas forks into a new draft (the
    // manual version survives on its own; the conversation moves with the
    // fork). Later turns iterate on the AI's own output in place.
    const s = useBuilderStore.getState();
    if (s.aiHistory.length === 0 && s.dirty && docHasContent(s.doc)) {
      spawnDraft(next, { origin: "ai", carryChat: true });
    } else {
      reset(next);
    }
    revealAll();
    pushMessage({
      role: "assistant",
      content: res.summary,
      warnings: res.warnings,
      ...(res.openQuestions && res.openQuestions.length > 0
        ? { openQuestions: res.openQuestions }
        : {}),
    });
    pushHistory([
      { role: "user", content: prompt.slice(0, 600) },
      { role: "assistant", content: res.summary.slice(0, 600) },
    ]);
  };

  const submit = (raw: string, opts?: { fromDeepLink?: boolean }) => {
    const prompt = raw.trim().slice(0, 500);
    if (prompt.length < 3 || generate.isPending) return;
    lastPrompt.current = { text: prompt, fromDeepLink: Boolean(opts?.fromDeepLink) };
    setInput("");
    syncFromCaret(""); // plain clear (not an Escape-dismiss of the token)
    pushMessage({ role: "user", content: prompt });
    setAiStatus("drafting");
    const hasConditions = conditionLeavesOf(doc.expr).length > 0;
    generate.mutate(
      {
        prompt,
        history: useBuilderStore.getState().aiHistory,
        currentDefinition: hasConditions ? compileDoc(doc) : null,
        ...(pinned.length > 0 ? { pinnedConditionIds: pinned.map((p) => p.conditionId) } : {}),
      },
      {
        onSuccess: (res) => {
          applyResult(prompt, res);
          setAiStatus("idle");
        },
        onError: () => setAiStatus("error"),
      },
    );
  };

  // Landing-page deep link (?prompt=…): fire exactly once on mount. Deferred
  // via a cleaned-up timer — mutating synchronously inside the mount effect
  // loses the settle notification under React StrictMode's simulated
  // unmount/remount (the panel then shows "thinking…" forever).
  useEffect(() => {
    if (autoFired.current) return;
    if (!initialPrompt || initialPrompt.trim().length < 3) return;
    const t = setTimeout(() => {
      if (autoFired.current) return;
      autoFired.current = true;
      submit(initialPrompt, { fromDeepLink: true });
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  // Advance the progress theater while a generation is in flight.
  useEffect(() => {
    if (!generate.isPending) {
      setStage(0);
      return;
    }
    const timers = STAGE_AT_MS.map((at, i) => setTimeout(() => setStage(i), at));
    return () => timers.forEach(clearTimeout);
  }, [generate.isPending]);

  // Keep the newest turn in view (guarded — jsdom has no scrollIntoView).
  useEffect(() => {
    logEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, generate.isPending]);

  // A new mention query restarts keyboard navigation at the top row.
  useEffect(() => setMentionIndex(0), [mention?.query]);

  const err = generate.error;
  const errorCopy = !err
    ? null
    : err instanceof ApiError && err.status === 429
      ? "You've hit today's free AI limit — pick a template below or come back tomorrow."
      : err instanceof ApiError && err.code === "AI_DISABLED"
        ? "AI generation is off right now — templates still work."
        : lastPrompt.current?.fromDeepLink
          ? "I couldn't draft that — retry, or start from a template."
          : err instanceof ApiError && err.code === "AI_GENERATION_FAILED"
            ? "I couldn't turn that into a valid strategy — try naming a market and a price."
            : "The AI is unreachable right now — try again in a moment, or start from a template.";

  const showTemplates = Boolean(errorCopy);
  const hasConversation = messages.length > 0;

  return (
    <aside className="flex h-full min-h-[360px] flex-col rounded-xl border border-brand/30 bg-surface shadow-panel">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
          <Sparkles size={14} className="text-accent" aria-hidden />
          Describe it — I&apos;ll build it
        </h3>
        <Badge tone="brand">AI beta</Badge>
      </div>

      {/* Conversation log: bounded by the panel column on lg (see
          PANEL_HEIGHT_CLASS); capped at half the viewport on mobile. */}
      <div className="builder-chat max-h-[50vh] min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 lg:max-h-full">
        {!hasConversation && !generate.isPending ? (
          <div className="space-y-2 px-1 py-2">
            <p className="text-[12px] leading-relaxed text-muted">
              Describe a strategy in plain language and I&apos;ll assemble it on the canvas from
              live market data. Follow-ups refine it in place — &ldquo;make it $200&rdquo;,
              &ldquo;add a liquidity check&rdquo;.
            </p>
            <p className="text-[11px] leading-snug text-faint">
              Type <span className="font-semibold">@</span> to pin a specific market.
            </p>
          </div>
        ) : null}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "w-fit max-w-[85%] rounded-lg rounded-br-sm bg-brand-soft px-3 py-2 text-[12px] leading-relaxed text-fg"
                  : "w-fit max-w-[92%] rounded-lg rounded-bl-sm bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-fg"
              }
            >
              {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
              {m.warnings && m.warnings.length > 0 ? (
                <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5">
                  {m.warnings.map((w, j) => (
                    <li key={j} className="text-[11px] leading-snug text-warn">
                      {w}
                    </li>
                  ))}
                </ul>
              ) : null}
              {m.openQuestions && m.openQuestions.length > 0 ? (
                <div className="mt-1.5 space-y-1 border-t border-border pt-1.5">
                  <p className="text-[11px] font-medium text-muted">I assumed / quick questions</p>
                  <div className="flex flex-wrap gap-1">
                    {m.openQuestions.map((q, j) => (
                      <button
                        key={j}
                        type="button"
                        onClick={() => {
                          setInput(q);
                          textareaRef.current?.focus();
                        }}
                        className="rounded-full border border-brand/40 bg-brand-soft px-2 py-0.5 text-left text-[11px] font-medium text-accent transition-colors hover:border-brand"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {generate.isPending ? (
          <div className="flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-2.5">
            <Spinner />
            <span className="text-[12px] font-medium text-accent">{STAGES[stage]}</span>
          </div>
        ) : null}

        {!generate.isPending && errorCopy ? (
          <p className="px-1 text-[12px] leading-snug text-neg">{errorCopy}</p>
        ) : null}

        {showTemplates ? (
          <div className="flex flex-wrap gap-1.5 px-1">
            {lastPrompt.current ? (
              <button
                type="button"
                onClick={() => {
                  const last = lastPrompt.current!;
                  submit(last.text, { fromDeepLink: last.fromDeepLink });
                }}
                className="rounded-full border border-brand/50 bg-brand-soft px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:border-brand"
              >
                Retry
              </button>
            ) : null}
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => spawnDraft(t.build(), { origin: `template:${t.id}` })}
                className="rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-fg"
              >
                {t.name}
              </button>
            ))}
          </div>
        ) : null}

        <div ref={logEndRef} />
      </div>

      {/* Composer */}
      <div className="space-y-2 border-t border-border px-3 py-3">
        {pinned.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {pinned.map((p) => (
              <span
                key={p.conditionId}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand/40 bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-accent"
              >
                {p.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image} alt="" className="h-3.5 w-3.5 rounded-sm object-cover" />
                ) : null}
                <span className="truncate">
                  {p.title.length > 36 ? `${p.title.slice(0, 33)}…` : p.title}
                </span>
                <button
                  type="button"
                  aria-label={`Unpin ${p.title}`}
                  onClick={() => unpin(p.conditionId)}
                  className="text-accent/70 transition-colors hover:text-accent"
                >
                  <X size={11} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="relative flex items-end gap-1.5"
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              syncFromCaret(e.target.value);
            }}
            onSelect={() => syncFromCaret(input)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && mention) {
                e.preventDefault();
                dismissMention();
                return;
              }
              if (mentionResults.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const max = mentionResults.length - 1;
                setMentionIndex((cur) => {
                  const i = Math.min(cur, max);
                  return e.key === "ArrowDown" ? (i >= max ? 0 : i + 1) : i <= 0 ? max : i - 1;
                });
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Enter while the @-dropdown is open picks the active match.
                if (mentionResults.length > 0) {
                  pickMention(mentionResults[Math.min(mentionIndex, mentionResults.length - 1)]!);
                  return;
                }
                submit(input);
              }
            }}
            maxLength={500}
            placeholder={
              hasConversation
                ? "Tweak it: “make it $200”, “add a liquidity check”…"
                : "e.g. buy YES if @market dips below 40¢ — type @ to pin a market"
            }
            aria-label="Describe your strategy"
            className="min-h-[52px] w-full resize-none rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-[13px] text-fg outline-none transition-colors placeholder:text-faint focus:border-brand"
          />
          <button
            type="submit"
            disabled={generate.isPending || input.trim().length < 3}
            aria-label="Generate strategy"
            className="rounded-lg bg-brand p-2.5 text-white transition-colors hover:bg-brand-strong disabled:opacity-40"
          >
            <Send size={15} aria-hidden />
          </button>

          <MentionDropdown
            results={mentionResults}
            activeIndex={Math.min(mentionIndex, Math.max(0, mentionResults.length - 1))}
            onPick={pickMention}
          />
        </form>

        <p className="text-[10px] leading-snug text-faint">
          AI drafts a strategy from live market data — always check it before saving. Orders are
          prepared for your signature; nothing trades by itself.
        </p>
      </div>
    </aside>
  );
}
