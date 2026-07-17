"use client";

/**
 * The hero demo's single state machine (Slice 5). Chat text, diagram chips,
 * chart markers and carousel dots ALL derive from this one reducer state, so
 * cross-panel sync is structural — there is nothing to coordinate.
 *
 * One 35ms interval drives everything: typing advances 1–2 chars per tick
 * (seeded jitter carried IN the reducer state — never Math.random in render),
 * then reveal (600ms) → hold (2600ms) → next scenario, wrapping.
 */
import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { DemoScenario, DiagramChip, TypedSegment } from "./demo-scenarios";
import { scenarioPromptText } from "./demo-scenarios";

export const DEMO_TICK_MS = 35;
export const DEMO_REVEAL_MS = 600;
export const DEMO_HOLD_MS = 2600;

export type DemoPhase = "typing" | "reveal" | "hold";

export interface DemoPlayerState {
  idx: number;
  phase: DemoPhase;
  /** Characters of the current scenario's prompt typed so far. */
  chars: number;
}

interface PlayerState extends DemoPlayerState {
  /** Ticks spent in the current reveal/hold phase. */
  ticksInPhase: number;
  /** PRNG state for typing jitter — advancing it is a pure reducer step. */
  seed: number;
}

type PlayerAction =
  | { type: "tick"; lens: readonly number[] }
  | { type: "goto"; idx: number; lens: readonly number[] };

/** One mulberry32 step as a pure function: (seed) → (nextSeed, value). */
const randStep = (seed: number): { seed: number; value: number } => {
  const a = ((seed >>> 0) + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { seed: a >>> 0, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
};

const reduce = (state: PlayerState, action: PlayerAction): PlayerState => {
  const count = action.lens.length;
  if (count === 0) return state;

  if (action.type === "goto") {
    const idx = ((action.idx % count) + count) % count;
    return { ...state, idx, phase: "reveal", chars: action.lens[idx] ?? 0, ticksInPhase: 0 };
  }

  const len = action.lens[state.idx] ?? 0;
  switch (state.phase) {
    case "typing": {
      const { seed, value } = randStep(state.seed);
      const chars = Math.min(len, state.chars + (value < 0.35 ? 2 : 1));
      return chars >= len
        ? { ...state, seed, chars: len, phase: "reveal", ticksInPhase: 0 }
        : { ...state, seed, chars };
    }
    case "reveal": {
      const ticks = state.ticksInPhase + 1;
      return ticks * DEMO_TICK_MS >= DEMO_REVEAL_MS
        ? { ...state, phase: "hold", ticksInPhase: 0 }
        : { ...state, ticksInPhase: ticks };
    }
    case "hold": {
      const ticks = state.ticksInPhase + 1;
      if (ticks * DEMO_TICK_MS < DEMO_HOLD_MS) return { ...state, ticksInPhase: ticks };
      return { ...state, idx: (state.idx + 1) % count, phase: "typing", chars: 0, ticksInPhase: 0 };
    }
  }
};

const init = ({ reduced, lens }: { reduced: boolean; lens: readonly number[] }): PlayerState => ({
  idx: 0,
  phase: reduced ? "reveal" : "typing",
  chars: reduced ? (lens[0] ?? 0) : 0,
  ticksInPhase: 0,
  seed: 0x9e3779b9,
});

export interface VisibleSegment {
  seg: TypedSegment;
  /** The substring of seg.text typed so far (never empty). */
  shown: string;
  done: boolean;
}

export interface DemoPlayer {
  state: DemoPlayerState;
  visibleSegments: VisibleSegment[];
  /** Chips whose appearAt segment is fully typed. */
  revealedChips: DiagramChip[];
  /** Chart markers show during reveal/hold (the "assembled" beat). */
  showMarkers: boolean;
  /** Manual jump (dots): lands fully typed in phase "reveal". */
  goTo: (i: number) => void;
}

export function useDemoPlayer(
  scenarios: readonly DemoScenario[],
  { paused = false, reduced = false }: { paused?: boolean; reduced?: boolean } = {},
): DemoPlayer {
  const lens = useMemo(() => scenarios.map((s) => scenarioPromptText(s).length), [scenarios]);

  const [raw, dispatch] = useReducer(reduce, { reduced, lens }, init);

  useEffect(() => {
    if (paused || reduced || lens.length === 0) return;
    const t = setInterval(() => dispatch({ type: "tick", lens }), DEMO_TICK_MS);
    return () => clearInterval(t);
  }, [paused, reduced, lens]);

  const goTo = useCallback((i: number) => dispatch({ type: "goto", idx: i, lens }), [lens]);

  const scenario = scenarios.length > 0 ? scenarios[raw.idx % scenarios.length]! : null;
  const totalLen = scenario ? (lens[raw.idx % scenarios.length] ?? 0) : 0;
  // Reduced motion renders fully revealed regardless of timer state.
  const chars = reduced ? totalLen : raw.chars;
  const phase: DemoPhase = reduced && raw.phase === "typing" ? "reveal" : raw.phase;

  const visibleSegments = useMemo<VisibleSegment[]>(() => {
    if (!scenario) return [];
    const out: VisibleSegment[] = [];
    let remaining = chars;
    for (const seg of scenario.prompt) {
      if (remaining <= 0) break;
      const shown = seg.text.slice(0, remaining);
      out.push({ seg, shown, done: shown.length === seg.text.length });
      remaining -= seg.text.length;
    }
    return out;
  }, [scenario, chars]);

  const revealedChips = useMemo<DiagramChip[]>(() => {
    if (!scenario) return [];
    // Cumulative char index at which each segment finishes typing.
    const cumEnd: number[] = [];
    let acc = 0;
    for (const seg of scenario.prompt) {
      acc += seg.text.length;
      cumEnd.push(acc);
    }
    return scenario.diagram.filter((chip) => (cumEnd[chip.appearAt] ?? Infinity) <= chars);
  }, [scenario, chars]);

  return {
    state: { idx: raw.idx, phase, chars },
    visibleSegments,
    revealedChips,
    showMarkers: phase === "reveal" || phase === "hold",
    goTo,
  };
}
