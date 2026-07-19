"use client";

/**
 * Global pending-transfer pill — Polymarket's little "deposit in progress"
 * companion. Fixed bottom-right on every page while any transfer is in
 * flight: pulsing dot + live stage text that cross-fades on each state
 * change, flipping to a green check for a few seconds on completion. Click
 * opens the Funds sheet on History with the transfer's tracker expanded;
 * the X dismisses until a newer transfer starts.
 *
 * This component is the app-wide polling floor: useActiveTransfers' interval
 * functions return slow/off when nothing is active, so idle pages stay quiet.
 */
import { AnimatePresence, m } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";
import { CheckDraw, PulseDot, SPRING_SOFT } from "@/components/motion/primitives";
import { useActiveTransfers } from "@/lib/use-active-transfers";
import { useFundsUi } from "@/lib/funds-ui";
import type { ActiveTransfer } from "@/lib/transfers";

const headline = (t: ActiveTransfer): string => {
  if (t.status === "success") {
    return t.kind === "conversion"
      ? "Conversion complete"
      : t.direction === "in"
        ? "Deposit complete"
        : "Withdrawal complete";
  }
  if (t.status === "failed") {
    return t.direction === "in" ? "Deposit failed" : "Withdrawal failed";
  }
  return t.kind === "conversion"
    ? `Converting ${t.amountLabel}`
    : t.direction === "in"
      ? `Depositing ${t.amountLabel}`
      : `Withdrawing ${t.amountLabel.replace("−", "")}`;
};

export function TransferPill() {
  const reduced = useReducedMotion();
  const activity = useActiveTransfers({ enabled: true });
  const sheetOpen = useFundsUi((s) => s.open);
  const openSheet = useFundsUi((s) => s.openSheet);
  const dismissPill = useFundsUi((s) => s.dismissPill);
  const pillDismissedAt = useFundsUi((s) => s.pillDismissedAt);

  const dismissedBefore = pillDismissedAt ?? 0;
  const active = activity.active.filter((t) => t.createdAt > dismissedBefore);
  const completed = activity.justCompleted.filter((t) => t.createdAt > dismissedBefore);

  // Freshly-completed beats in-flight (the green flash), newest first inside
  // each group. Hidden entirely while the sheet already shows everything.
  const current = completed[0] ?? active[0] ?? null;
  const show = !sheetOpen && current !== null;
  const extraCount = active.length - (current && current.status === "pending" ? 1 : 0);
  const success = current?.status === "success";
  const failed = current?.status === "failed";

  return (
    <AnimatePresence>
      {show && current ? (
        <m.div
          key="transfer-pill"
          className="fixed bottom-16 right-3 z-30"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
          transition={reduced ? { duration: 0 } : SPRING_SOFT}
          data-testid="transfer-pill"
        >
          <div
            className={cn(
              "flex items-center gap-2 rounded-lg border bg-bg py-2 pl-3 pr-2 shadow-pop",
              success ? "border-pos/40" : failed ? "border-neg/40" : "border-border",
            )}
          >
            <button
              type="button"
              onClick={() => openSheet("history", current.id)}
              className="flex items-center gap-2 text-left"
            >
              {success ? (
                <span className="text-pos">
                  <CheckDraw size={18} />
                </span>
              ) : failed ? (
                <span className="flex h-2.5 w-2.5 rounded-full bg-neg" aria-hidden />
              ) : (
                <PulseDot className="h-2.5 w-2.5" />
              )}
              <span className="min-w-0">
                <span className="tabular block truncate text-[12px] font-semibold leading-tight text-fg">
                  {headline(current)}
                  {extraCount > 0 ? (
                    <span className="ml-1 font-normal text-muted">+{extraCount} more</span>
                  ) : null}
                </span>
                <AnimatePresence mode="popLayout" initial={false}>
                  <m.span
                    key={current.stageLabel}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={reduced ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
                    className={cn(
                      "block text-[10px] leading-tight",
                      success ? "text-pos" : failed ? "text-neg" : "text-muted",
                    )}
                  >
                    {current.stageLabel}
                  </m.span>
                </AnimatePresence>
              </span>
            </button>
            <button
              type="button"
              onClick={dismissPill}
              className="rounded p-1 text-faint hover:text-fg"
              aria-label="Dismiss transfer status"
            >
              <X size={12} />
            </button>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
