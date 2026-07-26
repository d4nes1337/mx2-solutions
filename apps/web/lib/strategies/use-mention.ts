"use client";

/**
 * Shared @-mention machinery for chat composers (cockpit AI panel, home hero).
 * The token under the caret (`@world cu…`) drives a live market search;
 * picking a result rewrites the input to `@"Title" ` and pins the market
 * (capped at `maxPins` — the API accepts at most 4 pinned conditionIds).
 *
 * Trade-off: the query regex allows internal spaces so multi-word markets
 * ("@world cup") are searchable, which means a single space no longer ends
 * the token. Mention mode therefore ends only on explicit terminators —
 * Escape, picking a result, or two consecutive spaces. The cost: the dropdown
 * lingers while someone types an unrelated sentence after a stray `@`,
 * bounded by the 40-char query cap and those outs.
 */
import { useRef, useState, type RefObject } from "react";
import { useMarketSearch, type MarketSearchResult } from "./queries";

export interface PinnedMarket {
  conditionId: string;
  title: string;
  image: string;
}

export interface MentionState {
  query: string;
  start: number;
}

const MENTION_RE = /(?:^|\s)@(\S[^@\n]{0,39})$/;

const detectMention = (value: string, caret: number): MentionState | null => {
  const head = value.slice(0, caret);
  const m = MENTION_RE.exec(head);
  if (!m) return null;
  if (m[1]!.endsWith("  ")) return null; // double space: explicit terminator
  return { query: m[1]!, start: caret - m[1]!.length - 1 };
};

export function useMarketMention({
  value,
  setValue,
  textareaRef,
  maxPins = 4,
}: {
  value: string;
  setValue: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  maxPins?: number;
}) {
  const [mention, setMention] = useState<MentionState | null>(null);
  const [pinned, setPinned] = useState<PinnedMarket[]>([]);
  /** Start offset of an Escape-dismissed token — suppressed until it changes. */
  const dismissedStart = useRef<number | null>(null);

  const search = useMarketSearch(mention?.query ?? "");
  const results =
    mention && mention.query.length >= 2 ? (search.data?.results ?? []).slice(0, 8) : [];

  /** Re-detect the mention token from the current caret (change/select). */
  const syncFromCaret = (next: string) => {
    const caret = textareaRef.current?.selectionStart ?? next.length;
    const detected = detectMention(next, caret);
    if (detected !== null && detected.start === dismissedStart.current) return;
    dismissedStart.current = null;
    setMention(detected);
  };

  const dismiss = () => {
    dismissedStart.current = mention?.start ?? null;
    setMention(null);
  };

  const pick = (r: MarketSearchResult) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const inserted = `@"${r.title}" `;
    setValue(`${value.slice(0, mention.start)}${inserted}${value.slice(caret)}`.slice(0, 500));
    setPinned((p) =>
      p.length >= maxPins || p.some((x) => x.conditionId === r.conditionId)
        ? p
        : [...p, { conditionId: r.conditionId, title: r.title, image: r.image }],
    );
    dismissedStart.current = null;
    setMention(null);
    textareaRef.current?.focus();
  };

  const unpin = (conditionId: string) =>
    setPinned((cur) => cur.filter((x) => x.conditionId !== conditionId));

  /** Idempotent (dedup by conditionId) — deep links seed before auto-submit. */
  const seedPins = (pins: { conditionId: string; title: string; image?: string }[]) =>
    setPinned((cur) => {
      const next = [...cur];
      for (const p of pins) {
        if (next.length >= maxPins) break;
        if (next.some((x) => x.conditionId === p.conditionId)) continue;
        next.push({ conditionId: p.conditionId, title: p.title, image: p.image ?? "" });
      }
      return next.length === cur.length ? cur : next;
    });

  return { mention, results, pick, dismiss, syncFromCaret, pinned, unpin, seedPins };
}
