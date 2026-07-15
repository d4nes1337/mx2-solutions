"use client";

/**
 * Dependency-free spotlight tour. Each step targets a `[data-tour="…"]`
 * element; the overlay dims everything except the target (one huge box-shadow
 * — no canvas, no lib) and a small card explains it. Steps whose target is
 * missing on the page are skipped, so tours degrade gracefully across feature
 * flags and sign-in states.
 *
 * First visit shows a low-key invite card instead of hijacking the page;
 * completion/skip is persisted per tour in localStorage. The header Help
 * button can restart the mounted page's tour at any time (lib/onboarding.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import { registerTourStarter } from "@/lib/onboarding";
import { Button } from "@/components/ui";

export interface TourStep {
  /** data-tour attribute value; null = centered (no spotlight). */
  target: string | null;
  title: string;
  body: string;
}

interface InviteCopy {
  title: string;
  body: string;
}

const PAD = 8;

const storageGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return "done"; // storage unavailable → never auto-nag
  }
};

const storageSet = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Non-persistent is fine.
  }
};

export function Tour({
  steps,
  storageKey,
  invite,
}: {
  steps: TourStep[];
  storageKey: string;
  invite: InviteCopy;
}) {
  // "idle" → nothing; "invite" → first-visit card; number → active step index.
  const [state, setState] = useState<"idle" | "invite" | number>("idle");
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const finish = useCallback(() => {
    storageSet(storageKey, "done");
    setState("idle");
  }, [storageKey]);

  // First visit → offer the tour (never force it).
  useEffect(() => {
    if (storageGet(storageKey) === null) {
      const t = setTimeout(() => setState((s) => (s === "idle" ? "invite" : s)), 1_200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [storageKey]);

  // The header Help button restarts this page's tour.
  useEffect(() => registerTourStarter(() => setState(0)), []);

  // Resolve the current step's element; skip steps whose target is absent.
  const stepIdx = typeof state === "number" ? state : null;
  useEffect(() => {
    if (stepIdx === null) return undefined;
    const step = steps[stepIdx];
    if (!step) {
      finish();
      return undefined;
    }
    const el = step.target
      ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      : null;
    if (step.target && !el) {
      // Missing target (flag off / signed out) → skip forward.
      setState(stepIdx + 1 < steps.length ? stepIdx + 1 : "idle");
      if (stepIdx + 1 >= steps.length) storageSet(storageKey, "done");
      return undefined;
    }
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const update = () => setRect(el ? el.getBoundingClientRect() : null);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [stepIdx, steps, finish, storageKey]);

  // Esc dismisses; arrows navigate.
  useEffect(() => {
    if (stepIdx === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "Enter")
        setState((s) => (typeof s === "number" && s + 1 < steps.length ? s + 1 : "idle"));
      if (e.key === "ArrowLeft") setState((s) => (typeof s === "number" && s > 0 ? s - 1 : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepIdx, steps.length, finish]);

  useEffect(() => {
    if (stepIdx !== null) cardRef.current?.focus();
  }, [stepIdx]);

  if (state === "idle" || typeof window === "undefined") return null;

  if (state === "invite") {
    return createPortal(
      <div className="fade-in fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-border bg-surface p-4 shadow-pop">
        <div className="flex items-start justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
            <Sparkles size={14} className="text-accent" aria-hidden />
            {invite.title}
          </span>
          <button
            type="button"
            aria-label="Dismiss tour invitation"
            onClick={finish}
            className="rounded p-0.5 text-faint hover:text-fg"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{invite.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => setState(0)}>
            Show me
          </Button>
          <Button size="sm" variant="ghost" onClick={finish}>
            Skip
          </Button>
        </div>
      </div>,
      document.body,
    );
  }

  const step = steps[state];
  if (!step) return null;
  const spot = step.target && rect ? rect : null;

  // Card placement: under the target when there's room, else above; centered
  // when the step has no target. Clamped to the viewport horizontally.
  const cardW = 300;
  const cardStyle: React.CSSProperties = spot
    ? {
        position: "fixed",
        top:
          spot.bottom + 12 + 170 < window.innerHeight
            ? spot.bottom + 12
            : Math.max(12, spot.top - 182),
        left: Math.min(Math.max(12, spot.left), Math.max(12, window.innerWidth - cardW - 12)),
        width: cardW,
      }
    : {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: cardW,
      };

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={step.title}>
      {/* Click-away backdrop; the spotlight ring carries the dimming shadow. */}
      <div className="absolute inset-0" onClick={finish} />
      {spot ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-xl border-2 border-brand transition-all duration-200"
          style={{
            top: spot.top - PAD,
            left: spot.left - PAD,
            width: spot.width + PAD * 2,
            height: spot.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(6, 7, 13, 0.55)",
          }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-[rgba(6,7,13,0.55)]" />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        style={cardStyle}
        className="fade-in rounded-xl border border-border bg-surface p-4 shadow-pop outline-none"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-[13px] font-semibold text-fg">{step.title}</span>
          <span className="tabular shrink-0 text-[10px] text-faint">
            {state + 1}/{steps.length}
          </span>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{step.body}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={finish}>
            Skip
          </Button>
          <div className="flex items-center gap-1.5">
            {state > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setState(state - 1)}>
                Back
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => (state + 1 < steps.length ? setState(state + 1) : finish())}
            >
              {state + 1 < steps.length ? "Next" : "Done"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
