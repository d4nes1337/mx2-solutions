"use client";

/**
 * The hero's big AI chat window (Slice 4): the message area plays the
 * auto-typing demo (or rotates example thoughts when no demo is supplied),
 * the composer is a real chat input with @market mentions and pinned chips.
 * Submit deep-links into the cockpit (?prompt= + ?pinned=) where
 * BuilderShell seeds the pins and auto-fires the AI.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import { MentionDropdown } from "@/components/builder/MentionDropdown";
import { useReducedMotion } from "@/components/motion";
import { useMarketMention } from "@/lib/smart-orders/use-mention";
import { useAutogrowTextarea } from "@/lib/use-autogrow";

export function HeroChat({
  demo,
  examples,
  onInteract,
}: {
  /** The typing-demo bubble; when absent the message area rotates examples. */
  demo?: ReactNode;
  examples: string[];
  /** Fired on composer focus/typing — Hero pauses the demo and owns the resume timer. */
  onInteract?: () => void;
}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [value, setValue] = useState("");
  const [phIdx, setPhIdx] = useState(0);
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
  } = useMarketMention({ value, setValue, textareaRef });
  /** Keyboard cursor in the mention dropdown (arrows move, Enter picks). */
  const [mentionIndex, setMentionIndex] = useState(0);

  useEffect(() => {
    if (reduced || demo || examples.length === 0) return;
    const t = setInterval(() => setPhIdx((i) => (i + 1) % examples.length), 3_500);
    return () => clearInterval(t);
  }, [reduced, demo, examples.length]);

  // A new mention query restarts keyboard navigation at the top row.
  useEffect(() => setMentionIndex(0), [mention?.query]);

  const go = (raw: string) => {
    const v = raw.trim().slice(0, 500);
    if (v.length < 3) return;
    const pinnedParam =
      pinned.length > 0
        ? `&pinned=${pinned
            .map((p) => `${p.conditionId}~${encodeURIComponent(p.title.slice(0, 60))}`)
            .join(",")}`
        : "";
    router.push(`/smart-orders/new?prompt=${encodeURIComponent(v)}${pinnedParam}`);
  };

  return (
    <div className="flex min-h-[340px] flex-col rounded-xl border border-brand/40 bg-surface shadow-[0_0_24px_-8px_rgba(var(--brand-rgb),0.35)]">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-brand" aria-hidden />
        <span className="text-[12px] font-semibold text-fg">arima AI</span>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-faint">
          Describe it — it builds it
        </span>
      </div>

      <div className="flex flex-1 flex-col justify-end space-y-2 overflow-hidden px-3 py-3">
        {demo ?? (
          <div className="flex justify-end">
            <div className="w-fit max-w-[92%] rounded-lg rounded-br-sm border border-border bg-surface-2 px-3.5 py-2.5 text-[14px] italic leading-relaxed text-muted">
              {examples[phIdx % Math.max(1, examples.length)]}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border px-3 py-3" data-tour="hero-prompt">
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
            go(value);
          }}
          className="relative flex items-end gap-1.5"
        >
          <textarea
            ref={textareaRef}
            value={value}
            onFocus={() => onInteract?.()}
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
                // Enter while the @-dropdown is open picks the active match.
                if (mentionResults.length > 0) {
                  pickMention(mentionResults[Math.min(mentionIndex, mentionResults.length - 1)]!);
                  return;
                }
                go(value);
              }
            }}
            maxLength={500}
            placeholder="e.g. buy YES if @market dips below 40¢ — type @ to pin a market"
            aria-label="Describe your trading idea"
            className="min-h-[52px] w-full resize-none rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-[14px] text-fg outline-none transition-colors placeholder:text-faint focus:border-brand"
          />
          <button
            type="submit"
            disabled={value.trim().length < 3}
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

        <p className="text-[10px] leading-snug text-faint">
          Free — no account needed to build &amp; simulate.
        </p>
      </div>
    </div>
  );
}
