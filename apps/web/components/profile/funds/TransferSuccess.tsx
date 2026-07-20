"use client";

/**
 * The success moment: animated checkmark draw + celebrate burst. Rendered
 * only for completions OBSERVED this session (useActiveTransfers'
 * justCompleted), never for historical rows.
 *
 * When the account's next setup step is the allowance bootstrap, the primary
 * CTA becomes "Authorize trading" — the exact moment the owner expected an
 * authorize button and found nothing (beta finding).
 */
import { Button } from "@/components/ui";
import { CheckDraw } from "@/components/motion/primitives";
import { useBootstrapAllowances, useTradingAccounts } from "@/lib/queries";
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
  const accounts = useTradingAccounts(inbound);
  const bootstrap = useBootstrapAllowances();
  const needsAuthorize =
    inbound &&
    (accounts.data?.accounts ?? []).some(
      (a) => a.kind === "internal_privy" && a.nextAction === "bootstrap_allowances",
    );
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
      {needsAuthorize ? (
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={bootstrap.isPending}
            onClick={() => bootstrap.mutate()}
          >
            {bootstrap.isPending ? "Authorizing…" : "Next: authorize trading"}
          </Button>
          <p className="text-[11px] leading-snug text-muted">
            One-time, gasless approval so your strategies can place orders.
          </p>
          {bootstrap.isError ? (
            <p className="text-[11px] text-neg">
              {(bootstrap.error as Error)?.message ?? "Authorization failed"} — you can retry.
            </p>
          ) : null}
        </>
      ) : onPrimary ? (
        <Button size="sm" variant="primary" onClick={onPrimary}>
          {primaryLabel ?? (inbound ? "Start trading" : "Done")}
        </Button>
      ) : null}
    </div>
  );
}
