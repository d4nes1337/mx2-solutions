import type { QuoteEvent } from "./queries";

/**
 * Turn the quoter's append-only event payloads into one-line human sentences.
 * Falls back to the raw type for anything unrecognized — never hides events.
 */

const cents = (p: unknown) => `${Math.round(Number(p) * 100)}¢`;
const num = (v: unknown) => Number(v ?? 0);

const intentOf = (payload: Record<string, unknown>) =>
  (payload["intent"] ?? payload["quote"] ?? {}) as Record<string, unknown>;

const sideOf = (tokenLabelPayload: Record<string, unknown>): string => {
  const side = tokenLabelPayload["side"];
  return typeof side === "string" ? side : "BUY";
};

export const humanizeEvent = (e: QuoteEvent): string => {
  const p = e.payload;
  switch (e.type) {
    case "cycle": {
      if (p["desired"] === "idle") {
        const reason = String(p["reason"] ?? "idle");
        const why: Record<string, string> = {
          gate_unsatisfied: "conditions not met",
          no_book: "no orderbook yet",
          stale_book: "book data stale",
          mid_out_of_range: "price too close to 0/1",
        };
        return `Cycle: standing down (${why[reason] ?? reason})`;
      }
      return `Cycle: quoting around ${cents(p["mid"])} — ${num(p["resting"])} resting, ${num(p["places"])} placed, ${num(p["cancels"])} cancelled`;
    }
    case "quote_intent": {
      const i = intentOf(p);
      return `${p["mode"] === "shadow" ? "Would place" : "Placing"} ${sideOf(i)} ${num(i["size"])} @ ${cents(i["price"])}`;
    }
    case "order_placed": {
      const q = intentOf(p);
      return `Order resting: ${sideOf(q)} ${num(q["size"])} @ ${cents(q["price"])}`;
    }
    case "order_cancelled": {
      const q = intentOf(p);
      return `Quote pulled: ${num(q["size"])} @ ${cents(q["price"])}`;
    }
    case "fill":
      return `Filled ${num(p["sizeFilled"])} ${String(p["side"] ?? "")} @ ${cents(p["price"])}`;
    case "batch_proposed": {
      const batch = (p["batch"] ?? {}) as { places?: unknown[]; mergePairs?: number };
      return `Awaiting your approval: ${batch.places?.length ?? 0} quote(s)${
        (batch.mergePairs ?? 0) > 0 ? ` + merge ${batch.mergePairs} pairs` : ""
      }`;
    }
    case "merge_submitted":
      return `Merging ${num(p["pairs"])} YES+NO pairs → $${num(p["pairs"]).toFixed(0)} collateral (PnL ${Number(p["realizedPnlUsd"] ?? 0) >= 0 ? "+" : ""}$${Number(p["realizedPnlUsd"] ?? 0).toFixed(2)})`;
    case "merge_confirmed":
      return p["outcome"] === "failed"
        ? `Merge FAILED on-chain (tx ${String(p["transactionId"] ?? "?")})`
        : `Merge confirmed on-chain (${num(p["pairs"])} pairs)`;
    case "halt":
      return `HALTED: ${String(p["reason"] ?? "unknown")}`;
    case "resume":
      return "Resumed";
    default:
      return e.type;
  }
};

/** Stream display keeps signal high: collapse runs of idle cycles. */
export const compactEvents = (events: QuoteEvent[]): QuoteEvent[] => {
  const out: QuoteEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (
      e.type === "cycle" &&
      prev?.type === "cycle" &&
      prev.payload["desired"] === e.payload["desired"] &&
      prev.payload["reason"] === e.payload["reason"]
    ) {
      continue; // identical consecutive cycle — keep the newest only
    }
    out.push(e);
  }
  return out;
};
