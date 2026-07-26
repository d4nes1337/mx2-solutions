"use client";

/**
 * The homepage's one big input — a clean composer (the auto-typing demo lives
 * in the preview panel below, never inside the input the user is meant to
 * own). @-mentions pin markets, a pasted Polymarket URL resolves to a pin,
 * and the capability chips underneath double as documentation: they show
 * what the engine can watch and insert a teaching phrase on tap. Submit
 * deep-links into the builder (?prompt= + ?pinned=) which auto-fires the AI.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { MentionDropdown } from "@/components/builder/MentionDropdown";
import { useMarketMention } from "@/lib/strategies/use-mention";
import { useAutogrowTextarea } from "@/lib/use-autogrow";
import { api } from "@/lib/api";
import type { MarketSearchResult } from "@/lib/strategies/queries";

/** What the engine can watch — chips are documentation that types for you. */
const CAPABILITY_CHIPS: { label: string; insert: string }[] = [
  { label: "price level", insert: "if @ dips below 40¢, " },
  { label: "price move", insert: "if it drops 5¢ within 10 minutes, " },
  { label: "volume & liquidity", insert: "only if there's at least $2k of liquidity, " },
  { label: "schedule", insert: "only before Friday noon, " },
  { label: "trailing", insert: "buy the rebound 5¢ off the low, " },
];

const POLYMARKET_URL = /https?:\/\/(?:www\.)?polymarket\.com\/(?:event|market)\/([\w-]+)/i;

export function HeroComposer({ onInteract }: { onInteract?: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutogrowTextarea(textareaRef, value);

  const {
    mention,
    results: mentionResults,
    pick: pickMention,
    dismiss: dismissMention,
    syncFromCaret,
    pinned,
    unpin,
    seedPins,
  } = useMarketMention({ value, setValue, textareaRef });
  const [mentionIndex, setMentionIndex] = useState(0);
  useEffect(() => setMentionIndex(0), [mention?.query]);

  /** A pasted Polymarket link becomes a pinned market, not URL noise. */
  const tryPinFromUrl = (text: string): boolean => {
    const match = POLYMARKET_URL.exec(text);
    if (!match) return false;
    const slug = match[1]!.replace(/-/g, " ");
    void api
      .get<{ results: MarketSearchResult[] }>(`/api/markets/search?q=${encodeURIComponent(slug)}`)
      .then((res) => {
        const hit = res.results[0];
        if (hit) {
          seedPins([
            { conditionId: hit.conditionId, title: hit.title, ...(hit.image ? { image: hit.image } : {}) },
          ]);
        }
      })
      .catch(() => {
        /* search down — the paste just does nothing */
      });
    return true;
  };

  const go = (raw: string) => {
    const v = raw.trim().slice(0, 500);
    if (v.length < 3 && pinned.length === 0) return;
    const pinnedParam =
      pinned.length > 0
        ? `&pinned=${pinned
            .map((p) => `${p.conditionId}~${encodeURIComponent(p.title.slice(0, 60))}`)
            .join(",")}`
        : "";
    const prompt = v.length >= 3 ? v : "build a strategy on this market";
    router.push(`/strategies/new?prompt=${encodeURIComponent(prompt)}${pinnedParam}`);
  };

  const insertChip = (text: string) => {
    onInteract?.();
    setValue((cur) => (cur.length > 0 && !cur.endsWith(" ") ? `${cur} ${text}` : cur + text));
    textareaRef.current?.focus();
  };

  return (
    <div className="space-y-2.5">
      <div
        className="rounded-xl border border-brand/40 bg-surface p-3 shadow-[0_0_24px_-8px_rgba(var(--brand-rgb),0.35)]"
        data-tour="hero-prompt"
      >
        {pinned.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
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
            go(value);
          }}
          className="relative flex items-end gap-1.5"
        >
          <textarea
            ref={textareaRef}
            value={value}
            onFocus={() => onInteract?.()}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (tryPinFromUrl(text)) e.preventDefault();
            }}
            onChange={(e) => {
              setValue(e.target.value);
              syncFromCaret(e.target.value);
              onInteract?.();
            }}
            onSelect={() => syncFromCaret(value)}
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
                if (mentionResults.length > 0) {
                  pickMention(mentionResults[Math.min(mentionIndex, mentionResults.length - 1)]!);
                  return;
                }
                go(value);
              }
            }}
            maxLength={500}
            placeholder="if @fed-cuts-march goes above 67¢ and volume doubles in 5m, buy $50 of @recession-2026 — or paste a Polymarket link"
            aria-label="Describe your strategy"
            className="min-h-[56px] w-full resize-none bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            disabled={value.trim().length < 3 && pinned.length === 0}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brand bg-brand px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:border-brand-strong hover:bg-brand-strong disabled:opacity-40"
          >
            <Sparkles size={14} aria-hidden />
            Build it
          </button>

          <MentionDropdown
            results={mentionResults}
            activeIndex={Math.min(mentionIndex, Math.max(0, mentionResults.length - 1))}
            onPick={pickMention}
          />
        </form>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <span className="text-[11px] text-faint">it can watch:</span>
        {CAPABILITY_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => insertChip(chip.insert)}
            className="rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-brand/50 hover:text-fg"
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}
