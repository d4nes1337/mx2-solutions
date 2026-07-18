"use client";

/**
 * Local drafts on the Smart Orders tab: in-progress canvases (autosaved by the
 * builder) listed above the live strategy groups, so unfinished work is one
 * tap away. Drafts live in this browser's localStorage until armed.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { PenLine, Trash2 } from "lucide-react";
import { cn } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import {
  deleteDraftLocal,
  listDraftsLocal,
  type DraftMeta,
} from "@/lib/smart-orders/drafts";
import { importServerDrafts } from "@/lib/smart-orders/drafts-sync";

export function DraftsSection() {
  // Read after mount only: localStorage isn't available during SSR/hydration.
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  useEffect(() => {
    setDrafts(listDraftsLocal());
    // Merge account drafts from other devices, then refresh (fail-soft).
    void importServerDrafts().then((changed) => {
      if (changed > 0) setDrafts(listDraftsLocal());
    });
  }, []);

  if (drafts.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="h-3.5 w-0.5 rounded-full bg-brand-strong" />
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Drafts · {drafts.length}
        </h2>
        <span className="text-[10px] text-faint">saved on this device</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {drafts.map((d) => (
          <div
            key={d.id}
            className="group flex items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-3 shadow-panel transition-colors hover:border-border-strong"
          >
            <Link
              href={`/smart-orders/new?draft=${d.id}`}
              className="flex min-w-0 flex-1 items-center gap-2.5"
            >
              <PenLine size={14} aria-hidden className="shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {d.name.trim() === "" ? "Untitled draft" : d.name}
                </span>
                <span className="block text-[11px] text-faint">
                  edited {timeAgo(d.updatedAt / 1000)}
                </span>
              </span>
            </Link>
            <button
              type="button"
              aria-label={
                armedDelete === d.id ? "Confirm delete draft" : `Delete draft ${d.name || ""}`
              }
              title={armedDelete === d.id ? "Click again to delete" : "Delete draft"}
              onClick={() => {
                if (armedDelete !== d.id) {
                  setArmedDelete(d.id);
                  return;
                }
                deleteDraftLocal(d.id);
                setArmedDelete(null);
                setDrafts(listDraftsLocal());
              }}
              className={cn(
                "rounded p-1.5 transition-colors",
                armedDelete === d.id ? "text-neg" : "text-faint hover:text-neg",
              )}
            >
              <Trash2 size={13} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
