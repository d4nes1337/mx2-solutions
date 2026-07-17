import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoScenario } from "./demo-scenarios";
import { DEMO_HOLD_MS, DEMO_REVEAL_MS, DEMO_TICK_MS, useDemoPlayer } from "./use-demo-player";

// Segment lengths: 3 + 7 + 9 = 19 chars; chips at cumulative ends 3 and 19.
const makeScenario = (id: string): DemoScenario => ({
  id,
  title: id,
  prompt: [
    { text: "If ", highlight: "logic" },
    { text: "@Market", highlight: "market", isMarketSlot: true },
    { text: " then buy" },
  ],
  diagram: [
    { role: "condition", label: "c", appearAt: 0 },
    { role: "action", label: "a", appearAt: 2 },
  ],
  chart: { shape: "spike", base: 0.2, amplitude: 0.3, markers: [] },
  marketQuery: "market",
  buildPrompt: "build it",
});

const SCENARIOS = [makeScenario("s0"), makeScenario("s1"), makeScenario("s2")];
const PROMPT_LEN = 19;

const tick = (n = 1) => act(() => vi.advanceTimersByTime(n * DEMO_TICK_MS));

// Ticks a reveal/hold phase needs before flipping (threshold is >=, 1 tick each interval).
const REVEAL_TICKS = Math.ceil(DEMO_REVEAL_MS / DEMO_TICK_MS);
const HOLD_TICKS = Math.ceil(DEMO_HOLD_MS / DEMO_TICK_MS);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDemoPlayer", () => {
  it("types 1-2 chars per tick, then walks reveal → hold → next scenario", () => {
    const { result } = renderHook(() => useDemoPlayer(SCENARIOS));
    expect(result.current.state).toEqual({ idx: 0, phase: "typing", chars: 0 });
    expect(result.current.showMarkers).toBe(false);

    tick();
    expect(result.current.state.chars).toBeGreaterThanOrEqual(1);
    expect(result.current.state.chars).toBeLessThanOrEqual(2);

    // One char minimum per tick → PROMPT_LEN ticks always finishes typing.
    tick(PROMPT_LEN);
    expect(result.current.state.phase).toBe("reveal");
    expect(result.current.state.chars).toBe(PROMPT_LEN);
    expect(result.current.showMarkers).toBe(true);

    // Land exactly at the start of reveal via goTo (ticksInPhase = 0), then
    // walk the phase boundaries tick-precisely.
    act(() => result.current.goTo(0));
    tick(REVEAL_TICKS - 1);
    expect(result.current.state.phase).toBe("reveal");
    tick();
    expect(result.current.state.phase).toBe("hold");
    expect(result.current.showMarkers).toBe(true);

    tick(HOLD_TICKS - 1);
    expect(result.current.state.phase).toBe("hold");
    tick();
    expect(result.current.state).toEqual({ idx: 1, phase: "typing", chars: 0 });
  });

  it("wraps from the last scenario back to the first", () => {
    const { result } = renderHook(() => useDemoPlayer(SCENARIOS));
    act(() => result.current.goTo(2));
    tick(REVEAL_TICKS + HOLD_TICKS);
    expect(result.current.state.idx).toBe(0);
    expect(result.current.state.phase).toBe("typing");
  });

  it("reveals chips exactly when their appearAt segment finishes typing", () => {
    const { result } = renderHook(() => useDemoPlayer(SCENARIOS));
    // Invariant at every tick: chip 0 after segment 0 (3 chars), chip 1 at full text.
    for (let i = 0; i < PROMPT_LEN + 2; i++) {
      const { chars } = result.current.state;
      const expected = chars >= PROMPT_LEN ? 2 : chars >= 3 ? 1 : 0;
      expect(result.current.revealedChips).toHaveLength(expected);
      tick();
    }
    expect(result.current.revealedChips.map((c) => c.label)).toEqual(["c", "a"]);
  });

  it("exposes visible segments with partial substrings", () => {
    const { result } = renderHook(() => useDemoPlayer(SCENARIOS));
    tick(3); // 3-6 chars typed: segment 0 done, segment 1 partial
    const segs = result.current.visibleSegments;
    expect(segs[0]).toMatchObject({ shown: "If ", done: true });
    expect(segs.length).toBeGreaterThanOrEqual(1);
    if (segs.length > 1) {
      expect(segs[1]!.done).toBe(false);
      expect("@Market".startsWith(segs[1]!.shown)).toBe(true);
    }

    act(() => result.current.goTo(0));
    expect(result.current.visibleSegments.map((s) => s.shown).join("")).toBe("If @Market then buy");
    expect(result.current.visibleSegments.every((s) => s.done)).toBe(true);
  });

  it("goTo jumps to the target fully revealed", () => {
    const { result } = renderHook(() => useDemoPlayer(SCENARIOS));
    act(() => result.current.goTo(2));
    expect(result.current.state).toEqual({ idx: 2, phase: "reveal", chars: PROMPT_LEN });
    expect(result.current.showMarkers).toBe(true);
    expect(result.current.revealedChips).toHaveLength(2);

    act(() => result.current.goTo(-1)); // wraps
    expect(result.current.state.idx).toBe(2);
  });

  it("paused freezes chars", () => {
    const { result, rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useDemoPlayer(SCENARIOS, { paused }),
      { initialProps: { paused: false } },
    );
    tick(4);
    const frozen = result.current.state.chars;
    expect(frozen).toBeGreaterThan(0);

    rerender({ paused: true });
    tick(50);
    expect(result.current.state.chars).toBe(frozen);

    rerender({ paused: false });
    tick(2);
    expect(result.current.state.chars).toBeGreaterThan(frozen);
  });

  it("reduced renders scenario 0 fully revealed with no timer, manual goTo only", () => {
    const { result } = renderHook(() => useDemoPlayer(SCENARIOS, { reduced: true }));
    expect(result.current.state).toEqual({ idx: 0, phase: "reveal", chars: PROMPT_LEN });
    expect(result.current.showMarkers).toBe(true);
    expect(result.current.revealedChips).toHaveLength(2);

    tick(200); // no interval — nothing moves
    expect(result.current.state).toEqual({ idx: 0, phase: "reveal", chars: PROMPT_LEN });

    act(() => result.current.goTo(1));
    expect(result.current.state).toEqual({ idx: 1, phase: "reveal", chars: PROMPT_LEN });
  });

  it("tolerates an empty scenario list", () => {
    const { result } = renderHook(() => useDemoPlayer([]));
    tick(5);
    expect(result.current.visibleSegments).toEqual([]);
    expect(result.current.revealedChips).toEqual([]);
    act(() => result.current.goTo(3));
    expect(result.current.state.idx).toBe(0);
  });
});
