"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import {
  useConfirmTrigger,
  useDismissTrigger,
  useSubmitOrder,
  useTradeStatus,
  useTriggerDetail,
} from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { buildAndSignOrder, type Eip1193Provider } from "@/lib/order-sign";
import { Badge, Button, ErrorNote, Spinner, cn } from "./ui";

/**
 * Manual confirmation of a triggered rule (docs/04 §6). Shows the FRESH preview
 * + whether the condition still holds, then reuses the order sign+submit path.
 * Submission stays fail-closed behind the live-trading flag; a signature is
 * always required — a trigger never auto-submits.
 */
export function TriggerConfirm({ triggerId, onClose }: { triggerId: string; onClose: () => void }) {
  const detail = useTriggerDetail(triggerId);
  const { address, connector } = useAccount();
  const session = useSession();
  const tradeStatus = useTradeStatus();
  const submit = useSubmitOrder();
  const confirm = useConfirmTrigger();
  const dismiss = useDismissTrigger();
  const [signError, setSignError] = useState<string | null>(null);

  const funder = session.data?.depositWallet ?? "";
  const tradingEnabled = tradeStatus.data?.tradingEnabled === true;
  const d = detail.data;

  const signAndSubmit = async () => {
    setSignError(null);
    if (!address || !connector) return setSignError("Connect a wallet first.");
    if (!funder) return setSignError("No deposit wallet derived for this session.");
    if (!d) return;
    try {
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const order = await buildAndSignOrder(provider, {
        tokenId: d.preview.tokenId,
        side: d.preview.side,
        price: d.preview.price,
        size: d.preview.size,
        funder,
        signer: address,
        builderCode: d.preview.builderCode,
        chainId: 137,
        // MVP: neg-risk markets for triggered orders are a follow-up (see RFC-0001).
        negRisk: false,
      });
      const res = await submit.mutateAsync({
        idempotencyKey: `trigger:${triggerId}`,
        conditionId: d.preview.conditionId,
        price: d.preview.price,
        size: d.preview.size,
        orderType: "GTC",
        order,
      });
      await confirm.mutateAsync({ id: triggerId, orderIntentId: res.intentId });
      onClose();
    } catch (e) {
      setSignError(e instanceof Error ? e.message : "Signing failed.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Confirm triggered order</h2>
          <button onClick={onClose} className="text-muted hover:text-fg">
            ✕
          </button>
        </div>

        {detail.isLoading || !d ? (
          <Spinner label="Loading fresh preview…" />
        ) : (
          <div className="space-y-3 text-xs">
            {/* Does the condition still hold right now? */}
            <div
              className={cn(
                "rounded-md border p-3",
                d.conditionStillHolds
                  ? "border-pos/40 bg-pos/10 text-pos"
                  : "border-warn/40 bg-warn/10 text-warn",
              )}
            >
              <div className="font-semibold">
                {d.conditionStillHolds ? "Condition still holds" : "⚠ Condition no longer holds"}
              </div>
              <div className="mt-1">
                {d.fresh.isStale
                  ? "Latest data is stale."
                  : `best bid ${d.fresh.bestBid ?? "—"} · best ask ${d.fresh.bestAsk ?? "—"} · data age ${
                      d.fresh.dataAgeMs ?? "—"
                    }ms`}
              </div>
              {!d.conditionStillHolds ? (
                <div className="mt-1">
                  The edge may have moved since the trigger — review before signing.
                </div>
              ) : null}
            </div>

            {/* Fresh order preview */}
            <div className="space-y-1 rounded-md border border-border bg-surface-2 p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-semibold text-fg">Prepared order (fresh)</span>
                <Badge tone="warn">awaiting your signature</Badge>
              </div>
              <Row k="Side" v={d.preview.side} />
              <Row k="Price" v={d.preview.price} />
              <Row k="Size" v={d.preview.size} />
              <Row k="Max spend" v={`$${d.preview.maxSpend}`} />
              <Row k="Order type" v={d.preview.orderType} />
              <Row k="Funder (deposit)" v={funder || "—"} mono />
              <Row k="Builder code" v={d.preview.builderCode ?? "—"} mono />
              <p className="mt-1 text-warn">{d.warning}</p>
            </div>

            {/* Evidence (why it triggered) */}
            <details className="rounded-md border border-border bg-surface-2 p-3">
              <summary className="cursor-pointer font-semibold text-fg">
                Why did this trigger?
              </summary>
              <div className="mt-2 space-y-1">
                <Row
                  k="Window"
                  v={`${fmtMs(d.evidence.windowStartMs)} → ${fmtMs(d.evidence.windowEndMs)}`}
                />
                <Row
                  k="Best bid / ask"
                  v={`${d.evidence.bestBid ?? "—"} / ${d.evidence.bestAsk ?? "—"}`}
                />
                <Row k="Σ notional" v={d.evidence.cumulativeNotional?.toString() ?? "—"} />
                <Row k="Visible levels" v={d.evidence.visibleLevels?.toString() ?? "—"} />
                <Row k="Reason codes" v={d.evidence.reasonCodes.join(", ") || "—"} />
                <Row k="Rule hash" v={d.evidence.ruleDefinitionHash} mono />
                <Row k="Evaluator" v={d.evidence.evaluatorVersion} mono />
              </div>
            </details>

            {signError ? <ErrorNote message={signError} /> : null}
            {submit.error ? (
              <ErrorNote
                message={
                  submit.error instanceof Error ? submit.error.message : "Order submission failed."
                }
              />
            ) : null}

            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => dismiss.mutate(triggerId, { onSuccess: onClose })}
                disabled={dismiss.isPending}
              >
                Dismiss
              </Button>
              <Button
                className="flex-1"
                onClick={() => void signAndSubmit()}
                disabled={!tradingEnabled || submit.isPending || confirm.isPending}
                title={
                  tradingEnabled ? "Sign and submit" : "Live trading is disabled on the server"
                }
              >
                {submit.isPending || confirm.isPending
                  ? "Signing…"
                  : tradingEnabled
                    ? "Sign & submit"
                    : "Submit (trading disabled)"}
              </Button>
            </div>
            {!tradingEnabled ? (
              <p className="text-muted">
                Live trading is disabled — submission is blocked fail-closed. You can still dismiss.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const fmtMs = (ms: number) => new Date(ms).toLocaleTimeString();

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{k}</span>
      <span className={cn("text-fg", mono && "tabular max-w-[60%] truncate")}>{v}</span>
    </div>
  );
}
