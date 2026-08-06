"use client";

/**
 * "Open a draft" in the builder header — the only way back into earlier work,
 * now that the builder always opens blank and nothing is autosaved. Replaces
 * the old Drafts switcher AND the preset-template pills: the user picks from
 * their own saved strategies, not from someone else's starting points.
 *
 * Every switch that would throw the open canvas away goes through the leave
 * guard, so an unsaved canvas can't vanish behind a click in this menu.
 */
import { useState } from "react";
import { ChevronDown, Copy, FilePlus2, FolderOpen, Trash2 } from "lucide-react";
import { Button, cn } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import {
  deleteDraftLocal,
  duplicateDraftLocal,
  listDraftsLocal,
  type DraftMeta,
} from "@/lib/strategies/drafts";
import { useLeaveGuard } from "@/lib/strategies/leave-guard";
import { hasUnsavedWork, useBuilderStore } from "@/lib/strategies/store";
import { useOutsideClick } from "@/lib/use-outside-click";

export function DraftPicker({ onOpenDraft }: { onOpenDraft: (id: string) => void }) {
  const draftId = useBuilderStore((s) => s.draftId);
  const docName = useBuilderStore((s) => s.doc.name);
  const loadDraft = useBuilderStore((s) => s.loadDraft);
  const spawnDraft = useBuilderStore((s) => s.spawnDraft);
  const requestLeave = useLeaveGuard((s) => s.request);

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

  /** Run `swap` now, or after the user decides what to do with the open canvas. */
  const guarded = (because: string, swap: () => void) => {
    setOpen(false);
    if (!hasUnsavedWork(useBuilderStore.getState())) {
      swap();
      return;
    }
    requestLeave({ because, run: swap });
  };

  const openDraft = (id: string) =>
    guarded("open another draft", () => {
      if (loadDraft(id)) onOpenDraft(id);
    });

  const startBlank = () =>
    guarded("start a blank strategy", () =>
      onOpenDraft(spawnDraft(undefined, { origin: "blank" })),
    );

  const label = (d: DraftMeta) => (d.name.trim() === "" ? "Untitled draft" : d.name);

  return (
    <div ref={wrapRef} className="relative">
      <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open}>
        <FolderOpen size={13} aria-hidden />
        Open a draft
        <ChevronDown
          size={12}
          aria-hidden
          className={cn("transition-transform", open && "rotate-180")}
        />
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1.5 max-h-[70vh] w-[320px] overflow-y-auto rounded-lg border border-border bg-surface p-1.5 shadow-pop">
          <button
            type="button"
            onClick={startBlank}
            className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-[12px] font-medium text-accent transition-colors hover:bg-brand-soft"
          >
            <FilePlus2 size={13} aria-hidden /> Start blank
          </button>

          {drafts.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] leading-snug text-faint">
              No saved drafts yet — build something, then choose{" "}
              <span className="text-muted">Save draft</span> when you leave the builder.
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
                    {/* The open canvas's live name beats the stored index copy. */}
                    {current && docName.trim() !== "" ? docName : label(d)}
                    {current ? <span className="ml-1.5 text-[10px] text-accent">open</span> : null}
                  </span>
                  <span className="block text-[10px] text-faint">
                    saved {timeAgo(d.updatedAt / 1000)}
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
                    // Deleting the OPEN draft only drops the stored copy; the
                    // canvas stays put (and is now unsaved work again).
                    if (d.id === draftId) useBuilderStore.setState({ dirty: true });
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
