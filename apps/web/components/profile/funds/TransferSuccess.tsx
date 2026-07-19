"use client";

/**
 * The success moment: animated checkmark draw + celebrate burst. Rendered
 * only for completions OBSERVED this session (useActiveTransfers'
 * justCompleted), never for historical rows.
 */
import { Button } from "@/components/ui";
import { CheckDraw } from "@/components/motion/primitives";
import type { ActiveTransfer } from "@/lib/transfers";

export function TransferSuccess({
  transfer,
  onPrimary,
  primaryLabel,
}: {
  transfer: ActiveTransfer;
  onPrimary?: () => void;
  primaryLabel?: string;
}) {
  const inbound = transfer.direction === "in";
  return (
    <div
      className="celebrate flex flex-col items-center gap-2 rounded-md border border-pos/30 bg-pos/5 p-4 text-center"
      data-testid={`transfer-success-${transfer.id}`}
    >
      <span className="text-pos">
        <CheckDraw size={44} />
      </span>
      <div className="text-[14px] font-semibold text-fg">
        {inbound ? "Funds arrived" : "Withdrawal complete"}
      </div>
      <div className="tabular text-[12px] text-muted">
        {transfer.amountLabel}
        {!inbound && transfer.chainName ? ` · ${transfer.chainName}` : ""}
      </div>
      {onPrimary ? (
        <Button size="sm" variant="primary" onClick={onPrimary}>
          {primaryLabel ?? (inbound ? "Start trading" : "Done")}
        </Button>
      ) : null}
    </div>
  );
}
