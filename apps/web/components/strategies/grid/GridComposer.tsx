"use client";

/**
 * The grid builder's docked AI composer: a slim always-visible bar ("/" to
 * focus) that opens the full chat drawer on submit — same store-backed
 * conversation as the canvas AI tab, so switching views never loses the
 * thread. AI edits are never silent: the store snapshot powers the
 * "Undo AI edit" chip rendered beside the bar.
 */
import { useEffect, useRef, useState } from "react";
import { Sparkles, Undo2, X } from "lucide-react";
import { SheetShell } from "@/components/motion/primitives";
import { AiPanel } from "@/components/builder/AiPanel";
import { useBuilderStore } from "@/lib/strategies/store";

export function GridComposer({
  initialPrompt,
  initialPinned,
}: {
  /** Deep-link (?prompt=) — opens the drawer and auto-fires once. */
  initialPrompt?: string | null;
  initialPinned?: { conditionId: string; title: string }[];
}) {
  const [open, setOpen] = useState(() => Boolean(initialPrompt));
  const [pending, setPending] = useState<string | null>(initialPrompt ?? null);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const aiUndo = useBuilderStore((s) => s.aiUndo);
  const undoAiApply = useBuilderStore((s) => s.undoAiApply);

  // "/" focuses the composer from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => {
    setOpen(false);
    setPending(null); // never re-fire a consumed prompt on reopen
  };

  const submit = () => {
    const text = input.trim();
    if (text.length < 3) return;
    setInput("");
    setPending(text);
    setOpen(true);
  };

  return (
    <>
      <div className="sticky bottom-3 z-10 flex items-center gap-2">
        {aiUndo ? (
          <button
            type="button"
            onClick={undoAiApply}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/40 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-warn shadow-panel transition-colors hover:border-warn"
          >
            <Undo2 size={12} aria-hidden /> Undo AI edit
          </button>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-brand/40 bg-surface py-1.5 pl-3.5 pr-1.5 shadow-pop"
        >
          <Sparkles size={14} className="shrink-0 text-accent" aria-hidden />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Ask AI — "make it $200", "add a liquidity check"…  ( / )'
            aria-label="Ask AI to edit this strategy"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
            maxLength={500}
          />
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:text-fg"
          >
            Open chat
          </button>
          <button
            type="submit"
            disabled={input.trim().length < 3}
            className="shrink-0 rounded-full bg-brand px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-brand-strong disabled:opacity-40"
          >
            Ask
          </button>
        </form>
      </div>

      <SheetShell open={open} onClose={close} label="AI strategy chat">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-[13px] font-semibold text-fg">arima AI</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="text-muted transition-colors hover:text-fg"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="h-[70vh] p-3">
          {open ? (
            <AiPanel
              initialPrompt={pending}
              {...(initialPinned && initialPinned.length > 0 ? { initialPinned } : {})}
            />
          ) : null}
        </div>
      </SheetShell>
    </>
  );
}
