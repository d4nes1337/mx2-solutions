"use client";

import { useEffect } from "react";
import { AnimatePresence, m } from "motion/react";
import { Bell, X } from "lucide-react";
import { Button } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";

export interface ToastState {
  triggerId: string;
  title: string;
  body: string;
}

/**
 * The single Action Center toast (brief §6.6). Prominent but non-blocking:
 * anchored bottom-center so it never covers the wallet connector (top-right)
 * or the core builder controls. Dismissing the toast does NOT dismiss the
 * trigger — it only hides this surface. Auto-hides after a short while.
 */
export function ActionCenterToast({
  toast,
  onReview,
  onDismiss,
}: {
  toast: ToastState | null;
  onReview: (triggerId: string) => void;
  onDismiss: () => void;
}) {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(onDismiss, 9_000);
    return () => window.clearTimeout(t);
  }, [toast, onDismiss]);

  return (
    <AnimatePresence>
      {toast ? (
        <m.div
          role="status"
          aria-live="polite"
          className="fixed inset-x-3 bottom-4 z-[60] mx-auto max-w-sm rounded-xl border border-brand/40 bg-surface p-3 shadow-panel sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-soft text-accent">
              <Bell size={15} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-fg">{toast.title}</p>
              <p className="truncate text-[12px] text-muted">{toast.body}</p>
              <div className="mt-2">
                <Button size="sm" onClick={() => onReview(toast.triggerId)}>
                  Review &amp; sign
                </Button>
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={onDismiss}
              className="rounded-md p-1 text-muted transition-colors hover:text-fg"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
