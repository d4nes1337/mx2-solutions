"use client";

/**
 * Sheet hosting the store-bound ConditionEditor for one grid row — the exact
 * editor the canvas Block tab and QuickEditSheet mount, so every surface
 * edits a condition with the same controls.
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";
import { ConditionEditor } from "@/components/builder/editors/ConditionEditor";

export function RowEditorSheet({
  nodeId,
  onClose,
}: {
  /** Condition node to edit, or null when closed. */
  nodeId: string | null;
  onClose: () => void;
}) {
  return (
    <SheetShell open={nodeId !== null} onClose={onClose} label="Edit condition">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-semibold text-fg">Edit condition</h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-muted transition-colors hover:text-fg"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-4">
        {nodeId !== null ? <ConditionEditor id={nodeId} /> : null}
      </div>
      <div className="border-t border-border px-4 py-3">
        <Button className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    </SheetShell>
  );
}
