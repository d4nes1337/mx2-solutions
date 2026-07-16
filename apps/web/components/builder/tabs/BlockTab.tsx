"use client";

/**
 * Block tab of the workspace panel: the details/editor view for whichever
 * block is selected on the canvas. Tapping any canvas node lands here (market
 * nodes go to the Market tab instead); the same editor components also render
 * inside expanded canvas nodes — one editing implementation, two surfaces.
 */
import { MousePointerClick } from "lucide-react";
import { findNode } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { ConditionEditor } from "../editors/ConditionEditor";
import { ActionEditor, GroupEditor, RootLogicEditor } from "../editors/ActionEditor";

function Header({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">{kicker}</div>
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
    </div>
  );
}

export function BlockTab() {
  const doc = useBuilderStore((s) => s.doc);
  const selectedId = doc.selectedNodeId;

  if (!selectedId || selectedId.startsWith("market:")) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center">
        <MousePointerClick size={18} className="text-faint" aria-hidden />
        <p className="text-[13px] text-muted">
          Select a block on the canvas to edit it here — or expand the block itself with its ⌄
          button to edit in place.
        </p>
      </div>
    );
  }

  if (selectedId === "action") {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel">
        <Header kicker="Selected block" title="Action" />
        <ActionEditor />
      </div>
    );
  }

  if (selectedId === "root") {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel">
        <Header kicker="Selected block" title="Trigger logic" />
        <RootLogicEditor />
      </div>
    );
  }

  const node = findNode(doc.expr, selectedId);
  if (!node) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-[13px] text-muted">
        This block no longer exists.
      </p>
    );
  }

  if (node.type === "group") {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel">
        <Header
          kicker="Selected block"
          title={node.op === "and" ? "ALL-OF group" : node.op === "or" ? "ANY-OF group" : "NOT"}
        />
        <GroupEditor id={node.id} op={node.op} />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel">
      <Header kicker="Selected block" title="Condition" />
      <ConditionEditor id={node.id} />
    </div>
  );
}
