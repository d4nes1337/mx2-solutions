"use client";

/**
 * Instant markets rail — the builder picker's idle content: curated crypto
 * up-or-down series (BTC/ETH/SOL/XRP/DOGE × 5m/15m, BTC hourly) with the
 * LIVE window (ticking countdown) and the next pre-created future windows,
 * every one bindable Up or Down. Countdowns tick client-side; when the live
 * window closes the query is invalidated so the next window rolls in.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Repeat2, Zap } from "lucide-react";
import type { MarketRef, SeriesRef } from "@mx2/rules";
import { Spinner, cn } from "@/components/ui";
import type { MarketMeta } from "@/lib/strategies/doc";
import { metaFromResult, refFromResult } from "@/lib/strategies/pick";
import {
  useInstantMarkets,
  type InstantSeries,
  type InstantWindow,
} from "@/lib/strategies/queries";

type Cadence = "5m" | "15m" | "1h";
const CADENCES: Cadence[] = ["5m", "15m", "1h"];

const mmss = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m >= 60
    ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
    : `${m}:${String(s).padStart(2, "0")}`;
};

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function OutcomeButtons({
  window: win,
  onPick,
  onPickRolling,
  seriesSlug,
  seriesTitle,
}: {
  window: InstantWindow;
  onPick: (ref: MarketRef, meta: MarketMeta) => void;
  /** Present → each outcome also offers a rolling bind (ADR-0028). */
  onPickRolling?: ((ref: SeriesRef, anchor: MarketRef, meta: MarketMeta) => void) | undefined;
  seriesSlug?: string;
  seriesTitle?: string;
}) {
  return (
    <div className="flex shrink-0 gap-1.5">
      {win.market.outcomes.slice(0, 2).map((o, i) => {
        const ref = refFromResult(win.market, i);
        if (!ref) return null;
        return (
          <div key={o} className="flex flex-col items-stretch gap-0.5">
            <button
              type="button"
              onClick={() => onPick(ref, metaFromResult(win.market, i, { endDate: win.endDate }))}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                i === 0
                  ? "border-pos/30 bg-pos/10 text-pos hover:bg-pos/20"
                  : "border-neg/30 bg-neg/10 text-neg hover:bg-neg/20",
              )}
            >
              {o}
              {win.market.outcomePrices[i]
                ? ` · ${Math.round(Number(win.market.outcomePrices[i]) * 100)}¢`
                : ""}
            </button>
            {onPickRolling && seriesSlug ? (
              <button
                type="button"
                title={`Always trade the freshest ${seriesTitle ?? seriesSlug} window on ${o}`}
                onClick={() =>
                  onPickRolling(
                    {
                      kind: "series",
                      seriesSlug,
                      outcome: o,
                      selector: "current",
                      title: seriesTitle ?? seriesSlug,
                    },
                    ref,
                    metaFromResult(win.market, i, { endDate: win.endDate }),
                  )
                }
                className="inline-flex items-center justify-center gap-0.5 rounded-md border border-brand/40 bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-accent transition-colors hover:bg-brand-soft/70"
              >
                <Repeat2 size={9} aria-hidden />
                rolling
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SeriesRow({
  series,
  nowMs,
  onPick,
  onPickRolling,
}: {
  series: InstantSeries;
  nowMs: number;
  onPick: (ref: MarketRef, meta: MarketMeta) => void;
  onPickRolling?: ((ref: SeriesRef, anchor: MarketRef, meta: MarketMeta) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const live = series.windows.find((w) => Date.parse(w.endDate) > nowMs);
  const upcoming = series.windows.filter((w) => w !== live && Date.parse(w.endDate) > nowMs);
  const rolling = !live;

  return (
    <div className="rounded-lg border border-border bg-surface p-2">
      <div className="flex items-center gap-2">
        {live?.market.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={live.market.image}
            alt=""
            className="h-7 w-7 shrink-0 rounded-md object-cover"
          />
        ) : (
          <div className="h-7 w-7 shrink-0 rounded-md bg-surface-3" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium text-fg">{series.title}</span>
            <span className="shrink-0 rounded-sm bg-surface-3 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted">
              {series.cadence}
            </span>
          </div>
          {rolling ? (
            <div className="text-[10px] text-faint">rolling over…</div>
          ) : (
            <div className="tabular text-[10px] text-faint">
              <span className="mr-1 inline-flex items-center gap-1 font-semibold text-pos">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-pos" aria-hidden />
                LIVE
              </span>
              ends in {mmss(Date.parse(live.endDate) - nowMs)}
            </div>
          )}
        </div>
        {live ? (
          <OutcomeButtons
            window={live}
            onPick={onPick}
            onPickRolling={onPickRolling}
            seriesSlug={series.seriesSlug}
            seriesTitle={series.title}
          />
        ) : null}
      </div>

      {upcoming.length > 0 ? (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex items-center gap-1 px-1 text-[10px] font-medium text-muted transition-colors hover:text-fg"
          >
            <ChevronDown
              size={10}
              aria-hidden
              className={cn("transition-transform", expanded && "rotate-180")}
            />
            Next windows ({upcoming.length})
          </button>
          {expanded
            ? upcoming.map((w) => (
                <div key={w.eventId} className="mt-1 flex items-center gap-2 pl-1.5">
                  <div className="min-w-0 flex-1">
                    <span className="tabular text-[11px] text-fg">
                      {clockTime(w.startDate)}–{clockTime(w.endDate)}
                    </span>
                    <span className="tabular ml-1.5 text-[10px] text-faint">
                      starts in {mmss(Date.parse(w.startDate) - nowMs)}
                    </span>
                  </div>
                  <OutcomeButtons window={w} onPick={onPick} />
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

export function InstantMarketsRail({
  onPick,
  onPickRolling,
}: {
  onPick?: (ref: MarketRef, meta: MarketMeta) => void;
  /** Bind the ORDER to the whole series instead of one window (ADR-0028). */
  onPickRolling?: ((ref: SeriesRef, anchor: MarketRef, meta: MarketMeta) => void) | undefined;
}) {
  const [cadence, setCadence] = useState<Cadence>("5m");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const instant = useInstantMarkets(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(
    () => (instant.data?.series ?? []).filter((s) => s.cadence === cadence),
    [instant.data, cadence],
  );

  // When any visible live window crosses its end, pull fresh windows.
  const nextRolloverMs = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    for (const s of visible) {
      for (const w of s.windows) {
        const end = Date.parse(w.endDate);
        if (end > 0) min = Math.min(min, end);
      }
    }
    return min;
  }, [visible]);

  useEffect(() => {
    if (nowMs >= nextRolloverMs) {
      void queryClient.invalidateQueries({ queryKey: ["instant-markets"] });
    }
  }, [nowMs, nextRolloverMs, queryClient]);

  if (!onPick) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted">
          <Zap size={11} className="text-accent" aria-hidden />
          Instant markets
        </span>
        <div className="ml-auto flex gap-1">
          {CADENCES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCadence(c)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors",
                cadence === c
                  ? "border-brand/40 bg-brand-soft text-accent"
                  : "border-border bg-surface text-muted hover:text-fg",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {instant.isLoading ? (
        <div className="p-2">
          <Spinner label="Loading live windows…" />
        </div>
      ) : instant.error ? (
        <p className="px-1 text-[11px] text-muted">Instant markets are unavailable right now.</p>
      ) : visible.length === 0 ? (
        <p className="px-1 text-[11px] text-muted">No live windows for this cadence.</p>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {visible.map((s) => (
            <SeriesRow
              key={s.seriesSlug}
              series={s}
              nowMs={nowMs}
              onPick={onPick}
              onPickRolling={onPickRolling}
            />
          ))}
        </div>
      )}
    </div>
  );
}
