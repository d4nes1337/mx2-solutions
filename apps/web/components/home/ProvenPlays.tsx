"use client";

/**
 * "Proven plays" (Slice 6): a carousel of REAL backtested showcases. While
 * the showcase engine has nothing (warming up, error), the curated sample
 * plays keep charts on screen — captioned as samples, never sold as live
 * backtests (R-023). Auto-advances; paused on hover, off under
 * prefers-reduced-motion.
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";
import { useShowcases } from "@/lib/queries";
import { FALLBACK_SHOWCASES } from "@/lib/home/fallback-showcases";
import type { Showcase } from "@/lib/types";
import { ShowcaseCard } from "./ShowcaseCard";

const ROTATE_MS = 7_000;
const MAX_CARDS = 4;

export function ProvenPlays() {
  const sc = useShowcases();
  const reduced = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  const live = sc.data?.showcases ?? [];
  const sample = !sc.isLoading && live.length === 0;
  const cards: readonly Showcase[] = sample ? FALLBACK_SHOWCASES : live;
  const count = Math.min(cards.length, MAX_CARDS);

  useEffect(() => {
    if (reduced || paused || count <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % count), ROTATE_MS);
    return () => clearInterval(t);
  }, [reduced, paused, count]);

  return (
    <section
      className="space-y-3"
      data-tour="hero-showcase"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-fg">Proven plays</h2>
        <p className="text-[12px] text-muted">
          {sample
            ? "Sample plays — live backtests refresh every 15 min"
            : "Backtested on the last 30 days of real prices."}
        </p>
      </div>

      {sc.isLoading ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : count === 0 ? null : (
        <>
          <div key={cards[idx % count]!.id} className="fade-in">
            <ShowcaseCard showcase={cards[idx % count]!} sample={sample} />
          </div>

          {count > 1 ? (
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                aria-label="Previous strategy"
                onClick={() => setIdx((i) => (i - 1 + count) % count)}
                className="rounded-md border border-border bg-surface p-1 text-muted transition-colors hover:text-fg"
              >
                <ChevronLeft size={13} aria-hidden />
              </button>
              <div className="flex items-center gap-1.5">
                {cards.slice(0, count).map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-label={`Show strategy ${i + 1} of ${count}`}
                    aria-current={i === idx % count}
                    onClick={() => setIdx(i)}
                    className={`h-1.5 rounded-full transition-all ${
                      i === idx % count ? "w-5 bg-brand" : "w-1.5 bg-border-strong hover:bg-muted"
                    }`}
                  />
                ))}
              </div>
              <button
                type="button"
                aria-label="Next strategy"
                onClick={() => setIdx((i) => (i + 1) % count)}
                className="rounded-md border border-border bg-surface p-1 text-muted transition-colors hover:text-fg"
              >
                <ChevronRight size={13} aria-hidden />
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
