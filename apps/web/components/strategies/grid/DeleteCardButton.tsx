"use client";

/**
 * Two-click confirm delete for a whole grid card (a watch card takes its
 * conditions with it; the ACT card takes the configured order) — the canvas
 * toolbar's Clear pattern, so nothing in the builder drops a block of work on
 * one stray click. The armed window is longer than Clear's: this is a small
 * icon whose confirm the user has to read before clicking again.
 */
const DISARM_MS = 5_000;

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "@/components/ui";

export function DeleteCardButton({
  label,
  title = "Delete this card and its conditions",
  onConfirm,
}: {
  /** Read into the aria-label ("Delete <label>"). */
  label: string;
  title?: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), DISARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      aria-label={armed ? `Confirm delete ${label}` : `Delete ${label}`}
      title={armed ? "Click again to delete" : title}
      onClick={(e) => {
        e.stopPropagation(); // card headers double as the select target
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded p-1 transition-colors",
        armed ? "text-neg" : "text-faint hover:text-neg",
      )}
    >
      <Trash2 size={13} aria-hidden />
      {armed ? <span className="text-[10px] font-semibold">delete?</span> : null}
    </button>
  );
}
