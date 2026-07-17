"use client";

/**
 * Autogrow for chat composers: on each value change the textarea's height is
 * reset to `auto` (so it can shrink) and then pinned to its scrollHeight,
 * clamped to [minPx, maxPx]. Past the cap the textarea scrolls internally.
 */
import { useEffect, type RefObject } from "react";

export function useAutogrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { minPx = 52, maxPx = 160 }: { minPx?: number; maxPx?: number } = {},
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, minPx), maxPx);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
  }, [ref, value, minPx, maxPx]);
}
