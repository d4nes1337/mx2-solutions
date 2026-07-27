"use client";

/**
 * Sheet hosting the store-bound ConditionEditor for one grid row — the exact
 * editor the canvas Block tab and QuickEditSheet mount, so every surface
 * edits a condition with the same controls.
 */
import { Button } from "@/components/ui";
import { SheetPanel } from "@/components/ui/SheetPanel";
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
    <SheetPanel
      open={nodeId !== null}
      onClose={onClose}
      title="Edit condition"
      footer={
        <Button className="w-full" onClick={onClose}>
          Done
        </Button>
      }
    >
      {nodeId !== null ? <ConditionEditor id={nodeId} /> : null}
    </SheetPanel>
  );
}
