"use client";

// Client-side motion primitives — the "nervous system" that makes live data
// feel alive. Every animation degrades to an instant, static result under
// `prefers-reduced-motion`. Dependency-free (rAF + CSS keyframes in globals.css).

import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";

/** True when the user asked the OS to minimise motion. Re-evaluates on change. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * A number that tweens between values with requestAnimationFrame. Interruptions
 * are handled gracefully (the next tween starts from whatever is on screen).
 * Pass `mountFrom` to animate up from a starting value on first paint.
 */
export function AnimatedNumber({
  value,
  format = (n) => n.toFixed(2),
  duration = 500,
  mountFrom,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  mountFrom?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(() => mountFrom ?? value);
  const displayRef = useRef(display);

  useEffect(() => {
    if (reduced || duration <= 0) {
      displayRef.current = value;
      setDisplay(value);
      return;
    }
    const from = displayRef.current;
    if (from === value) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const cur = from + (value - from) * easeOutCubic(t);
      displayRef.current = cur;
      setDisplay(cur);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);

  return <span className={cn("tabular", className)}>{format(display)}</span>;
}

/** Count up from zero on mount, then track live updates like AnimatedNumber. */
export function CountUp(props: Omit<Parameters<typeof AnimatedNumber>[0], "mountFrom">) {
  return <AnimatedNumber mountFrom={0} duration={900} {...props} />;
}

/**
 * Wraps content and washes it green/red for a beat whenever `value` moves. The
 * `key` bump guarantees the CSS animation restarts even on same-direction ticks.
 */
export function FlashOnChange({
  value,
  children,
  className,
}: {
  value: number;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const prev = useRef(value);
  const [state, setState] = useState<{ cls: string; k: number }>({ cls: "", k: 0 });

  useEffect(() => {
    if (reduced || value === prev.current) {
      prev.current = value;
      return;
    }
    const cls = value > prev.current ? "flash-pos" : "flash-neg";
    prev.current = value;
    setState((s) => ({ cls, k: s.k + 1 }));
    const id = window.setTimeout(() => setState((s) => ({ ...s, cls: "" })), 600);
    return () => window.clearTimeout(id);
  }, [value, reduced]);

  return (
    <span key={state.k} className={cn("inline-block rounded-sm", state.cls, className)}>
      {children}
    </span>
  );
}

/**
 * Hook form of the flash for callers that want to drive their own element (e.g.
 * flashing a chart stroke). Returns "" | "flash-pos" | "flash-neg".
 */
export function usePriceFlash(value: number, duration = 600): "" | "flash-pos" | "flash-neg" {
  const reduced = useReducedMotion();
  const prev = useRef(value);
  const [cls, setCls] = useState<"" | "flash-pos" | "flash-neg">("");
  useEffect(() => {
    if (reduced || value === prev.current) {
      prev.current = value;
      return;
    }
    setCls(value > prev.current ? "flash-pos" : "flash-neg");
    prev.current = value;
    const id = window.setTimeout(() => setCls(""), duration);
    return () => window.clearTimeout(id);
  }, [value, duration, reduced]);
  return cls;
}

/** Staggered fade-in for lists. Each child animates a `step`ms after the last. */
export function Stagger({
  children,
  step = 45,
  className,
}: {
  children: ReactNode;
  step?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const items = Children.toArray(children);
  return (
    <>
      {items.map((child, i) => (
        <div
          key={i}
          className={cn(!reduced && "fade-in", className)}
          style={
            reduced
              ? undefined
              : { animationDelay: `${i * step}ms`, animationFillMode: "backwards" }
          }
        >
          {child}
        </div>
      ))}
    </>
  );
}
