/**
 * Deterministic layered auto-layout for the builder canvas: markets on the
 * left, conditions next, logic groups, then the action on the right. Only
 * fills positions that are missing so user-dragged nodes stay put.
 */
import type { ExprNode } from "@mx2/rules";
import { docMarketRefs, type NodePosition, type StrategyDoc } from "./doc";

const COL_X = { market: 0, condition: 300, logic: 620, action: 860 } as const;
const ROW_H = 130;
const TOP = 40;

export const layoutDoc = (doc: StrategyDoc): StrategyDoc => {
  const positions: Record<string, NodePosition> = { ...doc.positions };
  const place = (id: string, pos: NodePosition) => {
    if (!positions[id]) positions[id] = pos;
  };

  docMarketRefs(doc).forEach((ref, i) => {
    place(`market:${ref.tokenId}`, { x: COL_X.market, y: TOP + i * ROW_H });
  });

  let row = 0;
  let groupRow = 0;
  const walk = (node: ExprNode): void => {
    if (node.type === "condition") {
      place(node.id, { x: COL_X.condition, y: TOP + row * ROW_H });
      row++;
      return;
    }
    if (node.id !== "root") {
      place(node.id, { x: COL_X.logic, y: TOP + 40 + groupRow * ROW_H });
      groupRow++;
    }
    for (const child of node.children) walk(child);
  };
  walk(doc.expr);

  const rootY = TOP + Math.max(0, ((row || 1) - 1) * ROW_H) / 2;
  place("root", { x: COL_X.logic, y: rootY });
  place("action", { x: COL_X.action, y: rootY });

  return { ...doc, positions };
};
