"use client";

/**
 * History tab — every transfer (withdrawals, bridge withdrawals, bridge
 * deposits) rendered from the shared ActiveTransfer model, newest first.
 * Pending/failed rows expand on tap to reveal the compact staged tracker;
 * the pill's click-through auto-expands its transfer via focusTransferId.
 */
import { useEffect, useState } from "react";
import { ArrowDownToLine, ChevronDown, ExternalLink, History } from "lucide-react";
import { Spinner, cn } from "@/components/ui";
import { Stagger } from "@/components/motion";
import { AnimatedHeight } from "@/components/motion/primitives";
import { useActiveTransfers } from "@/lib/use-active-transfers";
import { useFundsUi } from "@/lib/funds-ui";
import type { ActiveTransfer } from "@/lib/transfers";
import { TransferTracker } from "./TransferTracker";

const subtitleFor = (t: ActiveTransfer): string => {
  switch (t.kind) {
    case "withdrawal":
      return "Withdrawal to login wallet";
    case "bridge_withdrawal":
      return `Withdrawal to ${t.chainName ?? "another chain"} (bridge)`;
    case "conversion":
      return "Converting to pUSD";
    default:
      return `Bridge deposit${t.chainName ? ` from ${t.chainName}` : ""}`;
  }
};

const toneFor = (t: ActiveTransfer): string =>
  t.status === "success" ? "text-pos" : t.status === "failed" ? "text-neg" : "text-accent";

export function HistoryPanel({ open }: { open: boolean }) {
  const activity = useActiveTransfers({ enabled: open });
  const focusTransferId = useFundsUi((s) => s.focusTransferId);
  const [expandedId, setExpandedId] = useState<string | null>(focusTransferId);
  useEffect(() => {
    if (focusTransferId) setExpandedId(focusTransferId);
  }, [focusTransferId]);

  if (activity.isLoading) {
    return <Spinner label="Loading transfers…" />;
  }
  if (activity.transfers.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        No transfers yet. Deposits appear here as they are detected; direct Polygon sends show on
        Polygonscan under the deposit wallet address.
      </p>
    );
  }
  return (
    <div className="max-h-72 space-y-1.5 overflow-y-auto" role="list">
      <Stagger step={30}>
        {activity.transfers.map((t) => {
          const expandable = t.status !== "success";
          const expanded = expandable && expandedId === t.id;
          return (
            <div
              key={t.id}
              role="listitem"
              className="rounded-lg border border-border bg-surface-2/60 px-3 py-2"
            >
              <button
                type="button"
                disabled={!expandable}
                onClick={() => setExpandedId(expanded ? null : t.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 text-left",
                  expandable && "cursor-pointer",
                )}
                aria-expanded={expandable ? expanded : undefined}
              >
                <div className="flex items-center gap-2">
                  {t.status === "success" ? (
                    <ArrowDownToLine size={13} className="text-pos" aria-hidden />
                  ) : (
                    <History size={13} className="text-muted" aria-hidden />
                  )}
                  <div>
                    <div className="tabular text-[13px] font-medium text-fg">{t.amountLabel}</div>
                    <div className="text-[10px] text-faint">
                      {subtitleFor(t)} · {new Date(t.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={cn("text-[11px] font-medium", toneFor(t))}>{t.stageLabel}</span>
                  {t.txUrl ? (
                    <a
                      href={t.txUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted hover:text-fg"
                      onClick={(e) => e.stopPropagation()}
                      aria-label="View transaction"
                    >
                      <ExternalLink size={12} />
                    </a>
                  ) : null}
                  {expandable ? (
                    <ChevronDown
                      size={12}
                      className={cn(
                        "text-faint transition-transform duration-150",
                        expanded && "rotate-180",
                      )}
                      aria-hidden
                    />
                  ) : null}
                </div>
              </button>
              {expandable ? (
                <AnimatedHeight>
                  {expanded ? (
                    <div className="pt-2">
                      <TransferTracker transfer={t} compact />
                    </div>
                  ) : null}
                </AnimatedHeight>
              ) : null}
            </div>
          );
        })}
      </Stagger>
    </div>
  );
}
