"use client";

import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";

/**
 * The Markets tab's hero search — a big, unmissable bar (Polymarket-style),
 * replacing the old w-36 header input. "/" focuses it from anywhere on the
 * page; Escape clears.
 */
export function MarketsHero({ q, onChange }: { q: string; onChange: (q: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <label className="mx-auto flex w-full max-w-3xl items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-panel transition-colors focus-within:border-brand">
      <Search size={18} className="shrink-0 text-faint" aria-hidden />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && q !== "") {
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder="Search all Polymarket markets…"
        aria-label="Search all markets"
        className="w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
      />
      {q !== "" ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="shrink-0 rounded-md p-0.5 text-faint transition-colors hover:text-fg"
        >
          <X size={15} aria-hidden />
        </button>
      ) : (
        <kbd className="hidden shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-faint sm:block">
          /
        </kbd>
      )}
    </label>
  );
}
