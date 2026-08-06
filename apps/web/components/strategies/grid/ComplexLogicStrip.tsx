"use client";

/**
 * Grouped logic the grid cannot faithfully edit (NOT, nested groups, groups
 * mixing markets) — rendered read-only so the grid NEVER silently flattens
 * an armed strategy's logic. The canvas remains the editor for these.
 */
import { Badge, Card, CardHeader } from "@/components/ui";
import { conditionLeavesOf, type StrategyDoc } from "@/lib/strategies/doc";
import { conditionSummary } from "@/lib/strategies/summaries";
import type { ComplexGroup } from "@/lib/strategies/grid-projection";
import type { GroupNode } from "@mx2/rules";
import { DeleteCardButton } from "./DeleteCardButton";

const opLabel = (op: GroupNode["op"]): string =>
  op === "and" ? "ALL OF" : op === "or" ? "ANY OF" : "NOT";

export function ComplexLogicStrip({
  doc,
  complex,
  onOpenCanvas,
  onRemoveGroup,
}: {
  doc: StrategyDoc;
  complex: ComplexGroup[];
  /** Present in the builder: jumps to the canvas view. */
  onOpenCanvas?: (() => void) | undefined;
  /**
   * Present in the builder: drop a whole grouped block. Editing these needs
   * the canvas, but DELETING one must not — otherwise a group the AI produced
   * can only be removed by opening the node editor.
   */
  onRemoveGroup?: ((nodeId: string) => void) | undefined;
}) {
  if (complex.length === 0) return null;
  return (
    <Card className="border-dashed">
      <CardHeader
        right={
          onOpenCanvas ? (
            <button
              type="button"
              onClick={onOpenCanvas}
              className="text-[12px] text-accent hover:underline"
            >
              Open canvas
            </button>
          ) : undefined
        }
      >
        Grouped logic
      </CardHeader>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-[11px] text-faint">
          This part of the logic is grouped beyond what the grid can edit — shown exactly as built.
          Use the canvas to change it.
        </p>
        {complex.map(({ node }) => (
          <div key={node.id} className="flex items-start gap-1.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 opacity-80">
              <Badge tone="neutral">{opLabel(node.op)}</Badge>
              {conditionLeavesOf(node).map(({ id, condition, negated }) => (
                <span
                  key={id}
                  className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
                >
                  {negated ? "NOT " : ""}
                  {conditionSummary(doc, condition).summary}
                </span>
              ))}
            </div>
            {onRemoveGroup ? (
              <DeleteCardButton
                label={`the ${opLabel(node.op)} group`}
                title="Delete this whole group"
                onConfirm={() => onRemoveGroup(node.id)}
              />
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}
