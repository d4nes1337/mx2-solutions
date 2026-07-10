"use client";

/**
 * The "vibe-trading" panel: turns a typed idea into a live strategy canvas.
 * Stateless server — this panel holds the compact conversation and re-sends
 * it (plus the current compiled definition) each turn, so follow-ups like
 * "make it $200" refine the canvas in place.
 */
import { useEffect, useRef, useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { Badge, Spinner } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  useGenerateStrategy,
  type AiGenerateResponse,
  type AiHistoryEntry,
} from "@/lib/ai/queries";
import { conditionLeavesOf, docFromDefinition } from "@/lib/smart-orders/doc";
import { compileDoc } from "@/lib/smart-orders/compile";
import { layoutDoc } from "@/lib/smart-orders/layout";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { TEMPLATES } from "@/lib/smart-orders/templates";

/** Progress theater: honest-ish stage copy while the model works. */
const STAGES = [
  "Reading your idea…",
  "Scanning live markets…",
  "Assembling conditions…",
  "Double-checking the logic…",
];
const STAGE_AT_MS = [0, 1_800, 5_000, 11_000];

export function AiPanel({ initialPrompt }: { initialPrompt?: string | null }) {
  const doc = useBuilderStore((s) => s.doc);
  const reset = useBuilderStore((s) => s.reset);
  const revealAll = useBuilderStore((s) => s.revealAll);
  const generate = useGenerateStrategy();

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<AiHistoryEntry[]>([]);
  const [assistantSays, setAssistantSays] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [stage, setStage] = useState(0);
  const autoFired = useRef(false);

  const applyResult = (prompt: string, res: AiGenerateResponse) => {
    if (res.status === "clarify") {
      setAssistantSays(res.question);
      setWarnings([]);
      setHistory((h) => [...h, { role: "user" as const, content: prompt.slice(0, 600) }].slice(-6));
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
    reset(next);
    revealAll();
    setAssistantSays(res.summary);
    setWarnings(res.warnings);
    setHistory((h) =>
      [
        ...h,
        { role: "user" as const, content: prompt.slice(0, 600) },
        { role: "assistant" as const, content: res.summary.slice(0, 600) },
      ].slice(-6),
    );
  };

  const submit = (raw: string) => {
    const prompt = raw.trim().slice(0, 500);
    if (prompt.length < 3 || generate.isPending) return;
    setInput("");
    const hasConditions = conditionLeavesOf(doc.expr).length > 0;
    generate.mutate(
      {
        prompt,
        history,
        currentDefinition: hasConditions ? compileDoc(doc) : null,
      },
      { onSuccess: (res) => applyResult(prompt, res) },
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
      submit(initialPrompt);
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

  const err = generate.error;
  const errorCopy = !err
    ? null
    : err instanceof ApiError && err.status === 429
      ? "You've hit today's free AI limit — pick a template below or come back tomorrow."
      : err instanceof ApiError && err.code === "AI_DISABLED"
        ? "AI generation is off right now — templates still work."
        : err instanceof ApiError && err.code === "AI_GENERATION_FAILED"
          ? "I couldn't turn that into a valid strategy — try naming a market and a price."
          : "The AI is unreachable right now — try again in a moment, or start from a template.";

  const showTemplates = Boolean(errorCopy);

  return (
    <aside className="space-y-2.5 rounded-xl border border-brand/30 bg-surface p-4 shadow-panel">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
          <Sparkles size={14} className="text-accent" aria-hidden />
          Describe it — I&apos;ll build it
        </h3>
        <Badge tone="brand">AI beta</Badge>
      </div>

      {generate.isPending ? (
        <div className="flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-2.5">
          <Spinner />
          <span className="text-[12px] font-medium text-accent">{STAGES[stage]}</span>
        </div>
      ) : null}

      {!generate.isPending && assistantSays ? (
        <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-fg">
          {assistantSays}
        </div>
      ) : null}

      {!generate.isPending && warnings.length > 0 ? (
        <ul className="space-y-1">
          {warnings.map((w, i) => (
            <li key={i} className="text-[11px] leading-snug text-warn">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {!generate.isPending && errorCopy ? (
        <p className="text-[12px] leading-snug text-neg">{errorCopy}</p>
      ) : null}

      {showTemplates ? (
        <div className="flex flex-wrap gap-1.5">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => reset(t.build())}
              className="rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-fg"
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="flex items-end gap-1.5"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(input);
            }
          }}
          rows={2}
          maxLength={500}
          placeholder={
            assistantSays
              ? "Tweak it: “make it $200”, “add a liquidity check”…"
              : "e.g. buy YES on the Fed cutting rates if it dips below 40¢"
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
      </form>

      <p className="text-[10px] leading-snug text-faint">
        AI drafts a strategy from live market data — always check it before saving. Orders are
        prepared for your signature; nothing trades by itself.
      </p>
    </aside>
  );
}
