"use client";

/**
 * Framer-motion primitives for the Funds experience (and anything else that
 * needs presence/spring/height animation the CSS keyframes can't do). Every
 * primitive consumes the app's `useReducedMotion` and degrades to an instant
 * static result. CSS keyframes in globals.css (pulse-dot, celebrate, fade-in,
 * flash-*) remain the tool for looping/one-shot effects.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m, type Transition } from "motion/react";
import { cn } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";

/** Snappy spring for modal/panel entrances (~200ms settle). */
export const SPRING: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.9 };
/** Softer spring for height/layout/pill movement. */
export const SPRING_SOFT: Transition = { type: "spring", stiffness: 260, damping: 30 };

const INSTANT: Transition = { duration: 0 };

/**
 * Modal shell: scrim + panel with spring-in/fade-out presence. Bottom sheet on
 * mobile, centered on desktop (same layout contract as the old FundsSheet).
 * Adds what the static version lacked: dialog semantics, Escape-to-close, and
 * initial focus.
 */
export function SheetShell({
  open,
  onClose,
  children,
  panelClassName,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  panelClassName?: string;
  /** Accessible dialog name. */
  label: string;
}) {
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <m.div
            className="absolute inset-0 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? INSTANT : { duration: 0.15 }}
            onClick={onClose}
            aria-hidden
          />
          <m.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            className={cn("relative z-10 outline-none", panelClassName)}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 12 }}
            transition={reduced ? INSTANT : SPRING}
          >
            {children}
          </m.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Animates its own height to follow the measured content (ResizeObserver —
 * reliable inside fixed overlays where layout animations misbehave). Content
 * renders in an inner wrapper; overflow is clipped during the tween.
 */
export function AnimatedHeight({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");

  useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    setHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  if (reduced) return <div className={className}>{children}</div>;
  return (
    <m.div
      className={cn("overflow-hidden", className)}
      initial={false}
      animate={{ height }}
      transition={SPRING_SOFT}
    >
      <div ref={innerRef}>{children}</div>
    </m.div>
  );
}

/**
 * Cross-fade + slide between panes keyed by `activeKey` (tab switches),
 * with the container height following the entering pane.
 */
export function TabPanes({
  activeKey,
  children,
  className,
}: {
  activeKey: string;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatedHeight className={className}>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.div
          key={activeKey}
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, x: -8 }}
          transition={reduced ? INSTANT : { duration: 0.16, ease: "easeOut" }}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </AnimatedHeight>
  );
}

/** Fade+rise presence wrapper for list items / trackers appearing in place. */
export function FadeRise({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <m.div
      className={className}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
      transition={reduced ? INSTANT : SPRING_SOFT}
    >
      {children}
    </m.div>
  );
}

/**
 * Animated checkmark: circle draws, then the tick — the success moment.
 * Color comes from `currentColor` (wrap in text-pos for the green check).
 */
export function CheckDraw({ size = 48, className }: { size?: number; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      role="img"
      aria-label="Success"
    >
      <m.circle
        cx="24"
        cy="24"
        r="21"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        initial={reduced ? undefined : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={reduced ? INSTANT : { duration: 0.35, ease: "easeOut" }}
      />
      <m.path
        d="M15 24.5l6.5 6.5L33.5 18"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduced ? undefined : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={reduced ? INSTANT : { duration: 0.25, delay: 0.3, ease: "easeOut" }}
      />
    </svg>
  );
}

/** Pulsing dot for the in-progress step (existing pulse-dot keyframes). */
export function PulseDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("pulse-dot inline-block h-2 w-2 rounded-full bg-brand", className)}
      aria-hidden
    />
  );
}
