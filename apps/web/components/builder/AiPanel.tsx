"use client";

/**
 * The AI tab: a full-height chat that turns typed ideas into a live strategy
 * canvas. Stateless server — the panel holds the conversation locally and
 * re-sends the recent turns (plus the current compiled definition) each time,
 * so follow-ups like "make it $200" refine the canvas in place.
 *
 * Display log vs API history: `messages` is what the user sees (optimistic —
 * the user turn appears immediately); `history` is the exact API contract
 * (pushed only on success, capped at 6 turns) so a failed request never
 * poisons the next one.
 */
import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";
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
import { useMarketSearch, type MarketSearchResult } from "@/lib/smart-orders/queries";
import { TEMPLATES } from "@/lib/smart-orders/templates";
import { cents, usdCompact, toNum } from "@/lib/format";

/** Progress theater: honest-ish stage copy while the model works. */
const STAGES = [
  "Reading your idea…",
  "Scanning live markets…",
  "Assembling conditions…",
  "Double-checking the logic…",
];
const STAGE_AT_MS = [0, 1_800, 5_000, 11_000];

/** Display-log cap — plenty for a session without unbounded growth. */
const MAX_MESSAGES = 40;

interface PinnedMarket {
  conditionId: string;
  title: string;
  image: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Engine warnings attached to an assistant turn. */
  warnings?: string[];
}

/**
 * Claude-Code-style @-mention: the token under the caret (`@fra…`) drives a
 * live market search. No spaces inside the query — a space ends the token.
 */
const detectMention = (value: string, caret: number): { query: string; start: number } | null => {
  const head = value.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]{1,40})$/.exec(head);
  if (!m) return null;
  return { query: m[1]!, start: caret - m[1]!.length - 1 };
};

export function AiPanel({ initialPrompt }: { initialPrompt?: string | null }) {
  const doc = useBuilderStore((s) => s.doc);
  const reset = useBuilderStore((s) => s.reset);
  const revealAll = useBuilderStore((s) => s.revealAll);
  const generate = useGenerateStrategy();

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<AiHistoryEntry[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stage, setStage] = useState(0);
  const autoFired = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [pinned, setPinned] = useState<PinnedMarket[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionSearch = useMarketSearch(mention?.query ?? "");
  const mentionResults =
    mention && mention.query.length >= 2 ? (mentionSearch.data?.results ?? []).slice(0, 5) : [];

  const syncMention = (value: string) => {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    setMention(detectMention(value, caret));
  };

  const pickMention = (r: MarketSearchResult) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const inserted = `@"${r.title}" `;
    setInput(`${input.slice(0, mention.start)}${inserted}${input.slice(caret)}`.slice(0, 500));
    setPinned((p) =>
      p.length >= 4 || p.some((x) => x.conditionId === r.conditionId)
        ? p
        : [...p, { conditionId: r.conditionId, title: r.title, image: r.image }],
    );
    setMention(null);
    textareaRef.current?.focus();
  };

  const pushMessage = (msg: ChatMessage) =>
    setMessages((m) => [...m, msg].slice(-MAX_MESSAGES));

  const applyResult = (prompt: string, res: AiGenerateResponse) => {
    if (res.status === "clarify") {
      pushMessage({ role: "assistant", content: res.question });
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
    pushMessage({ role: "assistant", content: res.summary, warnings: res.warnings });
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
    setMention(null);
    pushMessage({ role: "user", content: prompt });
    const hasConditions = conditionLeavesOf(doc.expr).length > 0;
    generate.mutate(
      {
        prompt,
        history,
        currentDefinition: hasConditions ? compileDoc(doc) : null,
        ...(pinned.length > 0 ? { pinnedConditionIds: pinned.map((p) => p.conditionId) } : {}),
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

  // Keep the newest turn in view (guarded — jsdom has no scrollIntoView).
  useEffect(() => {
    logEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, generate.isPending]);

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

      {/* Conversation log */}
      <div className="builder-chat max-h-[50vh] min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 lg:max-h-none">
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
                  ? "max-w-[85%] rounded-lg rounded-br-sm bg-brand-soft px-3 py-2 text-[12px] leading-relaxed text-fg"
                  : "max-w-[92%] rounded-lg rounded-bl-sm bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-fg"
              }
            >
              {m.content}
              {m.warnings && m.warnings.length > 0 ? (
                <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5">
                  {m.warnings.map((w, j) => (
                    <li key={j} className="text-[11px] leading-snug text-warn">
                      {w}
                    </li>
                  ))}
                </ul>
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
                  onClick={() =>
                    setPinned((cur) => cur.filter((x) => x.conditionId !== p.conditionId))
                  }
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
              syncMention(e.target.value);
            }}
            onSelect={() => syncMention(input)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && mention) {
                e.preventDefault();
                setMention(null);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Enter while the @-dropdown is open picks the top match.
                if (mentionResults.length > 0) {
                  pickMention(mentionResults[0]!);
                  return;
                }
                submit(input);
              }
            }}
            rows={2}
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

          {mentionResults.length > 0 ? (
            <div className="absolute bottom-full left-0 right-10 z-30 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop">
              {mentionResults.map((r) => (
                <button
                  key={r.conditionId}
                  type="button"
                  onClick={() => pickMention(r)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  {r.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.image}
                      alt=""
                      className="h-6 w-6 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div className="h-6 w-6 shrink-0 rounded-md bg-surface-3" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-[12px] font-medium text-fg">{r.title}</span>
                    <span className="tabular text-[10px] text-faint">
                      {r.outcomes[0] ?? "Yes"} {cents(Number(r.outcomePrices[0] ?? 0))} ·{" "}
                      {usdCompact(toNum(r.volume))} Vol
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </form>

        <p className="text-[10px] leading-snug text-faint">
          AI drafts a strategy from live market data — always check it before saving. Orders are
          prepared for your signature; nothing trades by itself.
        </p>
      </div>
    </aside>
  );
}
