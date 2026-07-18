"use client";

/**
 * Draft switcher in the builder header: every canvas the user touched is a
 * draft, and this is where they jump between them — recent drafts with
 * relative time, open/duplicate/delete per row, and "New draft". The list is
 * read from localStorage on open (autosave keeps it current to ~500ms).
 */
import { useState } from "react";
import { ChevronDown, Copy, FileText, Plus, Trash2 } from "lucide-react";
import { Button, cn } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import {
  deleteDraftLocal,
  duplicateDraftLocal,
  listDraftsLocal,
  type DraftMeta,
} from "@/lib/smart-orders/drafts";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useOutsideClick } from "@/lib/use-outside-click";

export function DraftSwitcher({ onOpenDraft }: { onOpenDraft: (id: string) => void }) {
  const draftId = useBuilderStore((s) => s.draftId);
  const docName = useBuilderStore((s) => s.doc.name);
  const loadDraft = useBuilderStore((s) => s.loadDraft);
  const spawnDraft = useBuilderStore((s) => s.spawnDraft);

  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  /** Row whose delete is armed (two-click confirm); disarms on any other action. */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const wrapRef = useOutsideClick<HTMLDivElement>(open, () => setOpen(false));

  const refresh = () => setDrafts(listDraftsLocal());

  const toggle = () => {
    if (!open) {
      refresh();
      setArmedDelete(null);
    }
    setOpen((o) => !o);
  };

  const openDraft = (id: string) => {
    if (loadDraft(id)) onOpenDraft(id);
    setOpen(false);
  };

  const newDraft = () => {
    // Force a fresh id even from a pristine canvas — "New draft" is explicit.
    const id = spawnDraft(undefined, { origin: "blank" });
    onOpenDraft(id);
    setOpen(false);
  };

  const label = (d: DraftMeta) => (d.name.trim() === "" ? "Untitled draft" : d.name);

  return (
    <div ref={wrapRef} className="relative">
      <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open}>
        <FileText size={13} aria-hidden />
        Drafts
        <ChevronDown
          size={12}
          aria-hidden
          className={cn("transition-transform", open && "rotate-180")}
        />
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-[320px] rounded-lg border border-border bg-surface p-1.5 shadow-pop">
          <button
            type="button"
            onClick={newDraft}
            className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-[12px] font-medium text-accent transition-colors hover:bg-brand-soft"
          >
            <Plus size={13} aria-hidden /> New draft
          </button>

          {drafts.length === 0 && !draftId ? (
            <p className="px-2.5 py-2 text-[12px] text-faint">
              No drafts yet — everything you build is saved here automatically.
            </p>
          ) : null}

          {drafts.map((d) => {
            const current = d.id === draftId;
            return (
              <div
                key={d.id}
                className={cn(
                  "group flex items-center gap-1 rounded-md px-1 transition-colors hover:bg-surface-2",
                  current && "bg-surface-2",
                )}
              >
                <button
                  type="button"
                  onClick={() => openDraft(d.id)}
                  className="min-w-0 flex-1 px-1.5 py-2 text-left"
                >
                  <span className="block truncate text-[12px] font-medium text-fg">
                    {/* The current draft's live name beats the (≤500ms stale) index copy. */}
                    {current && docName.trim() !== "" ? docName : label(d)}
                    {current ? (
                      <span className="ml-1.5 text-[10px] text-accent">current</span>
                    ) : null}
                  </span>
                  <span className="block text-[10px] text-faint">
                    {timeAgo(d.updatedAt / 1000)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Duplicate ${label(d)}`}
                  title="Duplicate"
                  onClick={() => {
                    const copyId = duplicateDraftLocal(d.id);
                    if (copyId) openDraft(copyId);
                  }}
                  className="rounded p-1.5 text-faint transition-colors hover:text-fg"
                >
                  <Copy size={12} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={
                    armedDelete === d.id ? `Confirm delete ${label(d)}` : `Delete ${label(d)}`
                  }
                  title={armedDelete === d.id ? "Click again to delete" : "Delete"}
                  onClick={() => {
                    if (armedDelete !== d.id) {
                      setArmedDelete(d.id);
                      return;
                    }
                    deleteDraftLocal(d.id);
                    setArmedDelete(null);
                    if (d.id === draftId) {
                      // Deleting the open draft: move to a fresh blank canvas.
                      onOpenDraft(useBuilderStore.getState().spawnDraft());
                    }
                    refresh();
                  }}
                  className={cn(
                    "rounded p-1.5 transition-colors",
                    armedDelete === d.id ? "text-neg" : "text-faint hover:text-neg",
                  )}
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
