"use client";

/**
 * Staged progress tracker for one in-flight transfer — the Polymarket-style
 * "we see your deposit" moment. Step nodes (done → filled check, current →
 * pulsing brand dot, future → hollow) sit on a connector track whose fill
 * springs to the current stage; the stage label cross-fades on every state
 * change. Failures collapse into a toned card with funds-safe vs support copy.
 * Purely presentational: everything comes from the normalized ActiveTransfer.
 */
import { AnimatePresence, m } from "motion/react";
import { Check, ExternalLink, X } from "lucide-react";
import { cn } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";
import { PulseDot, SPRING_SOFT } from "@/components/motion/primitives";
import { ChainIcon } from "@/components/wallet/ChainIcon";
import type { ActiveTransfer } from "@/lib/transfers";

export function TransferTracker({
  transfer,
  compact = false,
}: {
  transfer: ActiveTransfer;
  /** Hide per-step labels (history row expansion, pill flyouts). */
  compact?: boolean;
}) {
  const reduced = useReducedMotion();
  const { steps, status } = transfer;
  const lastIndex = Math.max(1, steps.length - 1);
  const success = status === "success";
  const failed = status === "failed";
  const progressIndex = success ? steps.length - 1 : transfer.currentStep;
  const fraction = success ? 1 : Math.min(1, progressIndex / lastIndex);

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        failed ? "border-neg/40 bg-neg/5" : "border-border bg-surface-2",
      )}
      data-testid={`transfer-tracker-${transfer.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {transfer.chainId ? (
            <ChainIcon
              chainId={transfer.chainId}
              name={transfer.chainName ?? ""}
              size={16}
              className="shrink-0"
            />
          ) : null}
          <span className="tabular truncate text-[13px] font-semibold text-fg">
            {transfer.amountLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <AnimatePresence mode="popLayout" initial={false}>
            <m.span
              key={transfer.stageLabel}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={reduced ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
              className={cn(
                "text-[11px] font-medium",
                failed ? "text-neg" : success ? "text-pos" : "text-accent",
              )}
            >
              {transfer.stageLabel}
            </m.span>
          </AnimatePresence>
          {transfer.txUrl ? (
            <a
              href={transfer.txUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-fg"
              aria-label="View transaction"
            >
              <ExternalLink size={11} />
            </a>
          ) : null}
        </div>
      </div>

      <div className="mt-3">
        <div className="relative">
          {/* Connector track + spring-filled progress, behind the nodes. */}
          <div className="absolute left-[7px] right-[7px] top-1/2 h-0.5 -translate-y-1/2 rounded bg-border" />
          <m.div
            className={cn(
              "absolute left-[7px] right-[7px] top-1/2 h-0.5 -translate-y-1/2 origin-left rounded",
              failed ? "bg-neg/60" : success ? "bg-pos" : "bg-brand",
            )}
            initial={false}
            animate={{ scaleX: fraction }}
            transition={reduced ? { duration: 0 } : SPRING_SOFT}
          />
          <div className="relative flex items-center justify-between">
            {steps.map((step, i) => {
              const done = success || i < progressIndex;
              const current = !success && i === progressIndex;
              return (
                <span key={step.id} className="relative z-10">
                  {done ? (
                    <span
                      className={cn(
                        "flex h-3.5 w-3.5 items-center justify-center rounded-full text-white",
                        success ? "bg-pos" : "bg-brand",
                      )}
                    >
                      <Check size={9} strokeWidth={3.5} aria-hidden />
                    </span>
                  ) : current && failed ? (
                    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-neg text-white">
                      <X size={9} strokeWidth={3.5} aria-hidden />
                    </span>
                  ) : current ? (
                    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-brand/50 bg-surface">
                      <PulseDot />
                    </span>
                  ) : (
                    <span className="block h-3.5 w-3.5 rounded-full border border-border bg-surface" />
                  )}
                </span>
              );
            })}
          </div>
        </div>

        {!compact ? (
          <div
            className="mt-1.5 grid gap-1"
            style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
          >
            {steps.map((step, i) => {
              const current = !success && i === progressIndex;
              return (
                <span
                  key={step.id}
                  className={cn(
                    "text-[9px] leading-tight",
                    i === 0 ? "text-left" : i === steps.length - 1 ? "text-right" : "text-center",
                    current && !failed
                      ? "font-medium text-fg"
                      : current && failed
                        ? "font-medium text-neg"
                        : "text-faint",
                  )}
                >
                  {step.label}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>

      {failed ? (
        <p className="mt-2 text-[11px] leading-snug text-neg">
          {transfer.failureTone === "support"
            ? "Something went wrong mid-transfer. The transfer is recorded — contact support and it can be recovered."
            : "Failed before funds moved — your balance is safe. You can simply try again."}
        </p>
      ) : null}
    </div>
  );
}
