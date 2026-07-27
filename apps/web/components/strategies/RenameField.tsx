"use client";

/**
 * Click-to-rename strategy title. Renaming only moves the display label (the
 * definition stays immutable), so it is safe on an armed strategy and never
 * re-arms it — the copy says so on first use rather than warning every time.
 *
 * Enter commits, Escape reverts, blur commits. An empty value clears the
 * override so the label falls back to the definition's own name.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/components/ui";
import { useRenameStrategy } from "@/lib/strategies/queries";

export function RenameField({
  id,
  name,
  /** Shown (and kept) when the strategy has no name of its own. */
  fallback,
  className,
  idle,
}: {
  id: string;
  name: string | null;
  fallback: string;
  className?: string;
  /**
   * Replaces the default click-to-rename title. Used where the title already
   * owns a different primary action (a list card opens the panel), so rename
   * gets its own small trigger instead of stealing the click.
   */
  idle?: (startEditing: () => void) => ReactNode;
}) {
  const rename = useRenameStrategy();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // A different strategy (or an external rename) resets the draft value.
  useEffect(() => setValue(name ?? ""), [name, id]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (value.trim() === (name ?? "")) return;
    rename.mutate({ id, name: value });
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setValue(name ?? "");
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        maxLength={120}
        placeholder={fallback}
        aria-label="Strategy name"
        className={cn(
          "min-w-0 flex-1 rounded-md border border-brand bg-surface px-1.5 py-0.5 text-[15px] font-semibold text-fg outline-none placeholder:font-normal placeholder:text-faint",
          className,
        )}
      />
    );
  }

  if (idle) return <>{idle(() => setEditing(true))}</>;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      title="Rename — this doesn't change the strategy's logic"
      className={cn(
        "group/rename inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-surface-2",
        className,
      )}
    >
      <span className={cn("truncate", name ? "text-fg" : "text-muted")}>{name || fallback}</span>
      <Pencil
        size={11}
        aria-hidden
        className="shrink-0 text-faint opacity-0 transition-opacity group-hover/rename:opacity-100"
      />
    </button>
  );
}
