/**
 * Plain-English strategy sentence. Pure: doc in, ordered segments out. Every
 * segment can carry the node id it describes so the chip UI can select the
 * corresponding canvas node on click.
 */
import type { ConditionV2, ExprNode } from "@mx2/rules";
import { marketLabel, isBound, type StrategyDoc } from "./doc";

export interface SentenceSegment {
  text: string;
  /** Node the chip focuses when clicked (null = plain connective text). */
  nodeId: string | null;
  tone?: "brand" | "pos" | "neg" | "warn";
}

const cents = (p: number): string => `${Math.round(p * 100)}¢`;
const usd = (n: number): string =>
  `$${n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : String(Math.round(n))}`;

export const humanDuration = (ms: number): string => {
  if (ms === 0) return "instantly";
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  if (ms < 3_600_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.round(ms / 3_600_000);
  return `${h} hour${h === 1 ? "" : "s"}`;
};

const describeCondition = (doc: StrategyDoc, c: ConditionV2): string => {
  switch (c.kind) {
    case "price": {
      const dir = c.comparator === "lte" ? "is below" : "is above";
      const side = c.source === "ask" ? "" : " (bid)";
      return `${c.market.outcome} price of ${marketLabel(doc, c.market)}${side} ${dir} ${cents(c.threshold)}`;
    }
    case "spread": {
      const dir = c.comparator === "lte" ? "is tighter than" : "is wider than";
      return `the spread on ${marketLabel(doc, c.market)} ${dir} ${cents(c.threshold)}`;
    }
    case "cumulative_notional":
      return `at least ${usd(c.minNotional)} of ${c.source} liquidity up to ${cents(c.priceBound)} on ${marketLabel(doc, c.market)}`;
    case "visible_levels":
      return `at least ${c.minLevels} visible ${c.source} levels up to ${cents(c.priceBound)} on ${marketLabel(doc, c.market)}`;
    case "time_window": {
      const fmt = (ms: number) =>
        new Date(ms).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      if (c.startMs !== null && c.endMs !== null)
        return `between ${fmt(c.startMs)} and ${fmt(c.endMs)}`;
      if (c.startMs !== null) return `after ${fmt(c.startMs)}`;
      if (c.endMs !== null) return `before ${fmt(c.endMs)}`;
      return "at any time";
    }
  }
};

const joinWord = (op: "and" | "or"): string => (op === "and" ? "and" : "or");

const describeExpr = (doc: StrategyDoc, node: ExprNode, out: SentenceSegment[]): void => {
  if (node.type === "condition") {
    out.push({ text: describeCondition(doc, node.condition), nodeId: node.id, tone: "brand" });
    return;
  }
  if (node.op === "not") {
    out.push({ text: "it is not the case that", nodeId: node.id, tone: "warn" });
    for (const child of node.children) describeExpr(doc, child, out);
    return;
  }
  const op = node.op === "or" ? "or" : "and";
  const nested = node.id !== "root" && node.children.length > 1;
  if (nested) out.push({ text: "(", nodeId: node.id });
  node.children.forEach((child, i) => {
    if (i > 0) out.push({ text: joinWord(op), nodeId: node.id === "root" ? null : node.id });
    describeExpr(doc, child, out);
  });
  if (nested) out.push({ text: ")", nodeId: node.id });
};

export const describeStrategy = (doc: StrategyDoc): SentenceSegment[] => {
  const out: SentenceSegment[] = [];

  if (doc.expr.children.length === 0) {
    out.push({ text: "If…", nodeId: "root" });
    out.push({ text: "add a condition to begin", nodeId: null });
  } else {
    out.push({ text: "If", nodeId: null });
    describeExpr(doc, doc.expr, out);
    if (doc.holdsForMs > 0) {
      out.push({
        text: `holding for ${humanDuration(doc.holdsForMs)}`,
        nodeId: "root",
        tone: "warn",
      });
    }
  }

  out.push({ text: "→", nodeId: null });

  switch (doc.action.kind) {
    case "alert":
      out.push({ text: "alert me", nodeId: "action", tone: "pos" });
      break;
    case "order": {
      const a = doc.action;
      const verb = a.side === "BUY" ? "buy" : "sell";
      const where = isBound(a.market) ? ` on ${marketLabel(doc, a.market)}` : "";
      const how =
        a.execution === "auto"
          ? " automatically from my Arima trading wallet"
          : " and ask me to sign";
      out.push({
        text: `${verb} ${a.size} ${a.market.outcome} at ${cents(a.price)}${where}${how}`,
        nodeId: "action",
        tone: a.side === "BUY" ? "pos" : "neg",
      });
      break;
    }
    case "stop_strategy":
      out.push({ text: "stop another Smart Order", nodeId: "action", tone: "warn" });
      break;
  }

  if (doc.recurrence.kind === "repeat") {
    out.push({
      text: `repeat up to ${doc.recurrence.maxRepeats}× (${humanDuration(doc.recurrence.cooldownMs)} cooldown)`,
      nodeId: "root",
      tone: "warn",
    });
  }

  return out;
};

/** The whole sentence as one string (tests, tooltips, monitor cards). */
export const strategySentence = (doc: StrategyDoc): string =>
  describeStrategy(doc)
    .map((s) => s.text)
    .join(" ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
