"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAckTrigger,
  useConfirmTrigger,
  useOrderbookByToken,
  useSetPrimaryTradingAccount,
  useSubmitOrder,
  useTokenPricesHistory,
  useTradeStatus,
  useTradingAccounts,
  useTriggerDetail,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { friendlySubmitError } from "@/lib/order-errors";
import { autoFailureCopy } from "@/lib/strategies/auto-reasons";
import { spliceLive, type LiveQuote } from "@/lib/strategies/live-splice";
import type { ActionCenterResponse } from "@/lib/types";
import { buildAndSignOrder, type Eip1193Provider } from "@/lib/order-sign";
import { ensurePolygonChain } from "@/lib/chain";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { LiveCaption } from "@/components/charts/LiveCaption";
import { PolymarketLink } from "@/components/PolymarketLink";
import { Badge, Button, ErrorNote, Spinner, cn } from "./ui";

/**
 * The ready popup — manual confirmation of a triggered strategy (docs/04 §6).
 * Chart-first and dollars-first: the live target market with the trigger
 * moment marked answers "why did this fire, is it still good?" at a glance;
 * the numbers row answers "what exactly am I approving?". All honest-state
 * logic is preserved: the FRESH server preview decides READY vs PRICE-MOVED
 * vs STALE, submission stays fail-closed behind the live-trading flag, and a
 * signature is always required — a trigger never auto-submits. The primary
 * button is never auto-focused (no accidental Enter-to-sign).
 */
export function TriggerConfirm({ triggerId, onClose }: { triggerId: string; onClose: () => void }) {
  const detail = useTriggerDetail(triggerId);
  const { address, connector } = useAccount();
  const tradingAccounts = useTradingAccounts();
  const tradeStatus = useTradeStatus();
  const setPrimaryAccount = useSetPrimaryTradingAccount();
  const submit = useSubmitOrder();
  const confirm = useConfirmTrigger();
  const ack = useAckTrigger();
  const [signError, setSignError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const d = detail.data;
  const history = useTokenPricesHistory(d?.preview.tokenId ?? null, "1d");
  // Live book (2s poll): the chart's leading edge + the "ask now" figure. The
  // v2 trigger-detail endpoint doesn't carry bestAsk/dataAgeMs, so this is
  // the only genuinely fresh price in the modal.
  const book = useOrderbookByToken(d?.preview.tokenId ?? null);
  const bookQuote = useMemo<LiveQuote | null>(() => {
    const b = book.data;
    if (!b) return null;
    const bids = b.bids.map((l) => Number(l.price)).filter(Number.isFinite);
    const asks = b.asks.map((l) => Number(l.price)).filter(Number.isFinite);
    const ageRaw = Date.now() - Date.parse(b.receivedAt);
    return {
      bestBid: bids.length ? Math.max(...bids) : null,
      bestAsk: asks.length ? Math.min(...asks) : null,
      dataAgeMs: Number.isFinite(ageRaw) ? Math.max(0, ageRaw) : null,
    };
  }, [book.data]);

  // While the fresh preview loads, the bell's cached snapshot of this trigger
  // (matched by id — never another trigger's numbers) seeds the header so the
  // modal opens with the order in view instead of a bare spinner.
  const seed = !d
    ? queryClient
        .getQueryData<ActionCenterResponse>(["action-center"])
        ?.items.find((item) => item.triggerId === triggerId)
    : undefined;

  const activeAccount = tradingAccounts.data?.primaryAccount ?? null;
  const accounts = tradingAccounts.data?.accounts ?? [];
  const funder = activeAccount?.funderAddress ?? "";
  const tradingEnabled = tradeStatus.data?.tradingEnabled === true;
  const connectedMatchesActive =
    Boolean(address && activeAccount) &&
    address!.toLowerCase() === activeAccount!.signerAddress.toLowerCase();
  const selectedBrowserAccountReady =
    activeAccount?.signingMode === "browser" &&
    activeAccount.credentialsReady &&
    connectedMatchesActive;
  const submitButtonLabel =
    submit.isPending || confirm.isPending
      ? "Signing…"
      : !activeAccount
        ? "Select wallet"
        : activeAccount.signingMode !== "browser"
          ? "Wallet pending"
          : !activeAccount.credentialsReady
            ? "Credentials needed"
            : !connectedMatchesActive
              ? "Connect selected wallet"
              : tradingEnabled
                ? "Sign & submit"
                : "Submit (trading disabled)";

  const signAndSubmit = async () => {
    setSignError(null);
    // Single error sink: the catch below is the only renderer of a failure, so
    // clear any stale mutation error state before a new attempt.
    submit.reset();
    confirm.reset();
    if (!activeAccount) return setSignError("Select a trading account first.");
    if (activeAccount.signingMode !== "browser") {
      return setSignError("This trading account is not ready for triggered live orders yet.");
    }
    if (!activeAccount.credentialsReady) {
      return setSignError("Set up trading credentials for this wallet in the order ticket first.");
    }
    if (!address || !connector) return setSignError("Connect a wallet first.");
    if (address.toLowerCase() !== activeAccount.signerAddress.toLowerCase()) {
      return setSignError("Switch your connected wallet to the selected trading account first.");
    }
    if (!funder) return setSignError("No funder configured for the selected trading account.");
    if (!d) return;
    try {
      const provider = (await connector.getProvider()) as Eip1193Provider;
      // Polygon first: every order signature is an EIP-712 payload pinned to
      // chain 137 — switch the wallet over so strict wallets don't refuse.
      await ensurePolygonChain(provider);
      const order = await buildAndSignOrder(provider, {
        tokenId: d.preview.tokenId,
        side: d.preview.side,
        price: d.preview.price,
        size: d.preview.size,
        funder,
        signer: activeAccount.signerAddress,
        // The account's real type — hardcoding Gnosis-Safe here broke every
        // non-Safe wallet with "invalid POLY_GNOSIS_SAFE signature".
        signatureType: activeAccount.signatureType,
        builderCode: d.preview.builderCode,
        chainId: 137,
        // GTD entry windows: the API preview computed the wire expiration
        // (trigger time + window + 60s compensation, ADR-0013).
        ...(d.preview.expiration ? { expiration: d.preview.expiration } : {}),
        // Market metadata from the preview: negRisk picks the verifying
        // exchange contract, tickSize the amount rounding. Signing a neg-risk
        // market against the standard exchange is an invalid signature.
        negRisk: d.preview.negRisk ?? false,
        ...(d.preview.tickSize ? { tickSize: d.preview.tickSize } : {}),
      });
      const res = await submit.mutateAsync({
        tradingAccountId: activeAccount.id,
        idempotencyKey: `trigger:${triggerId}`,
        conditionId: d.preview.conditionId,
        price: d.preview.price,
        size: d.preview.size,
        orderType: d.preview.orderType,
        postOnly: d.preview.postOnly,
        order,
      });
      // A replayed FAILED intent must never read as success — confirming the
      // trigger on it is how strategies used to vanish with no order placed.
      if (res.status === "failed") {
        throw new Error(
          "The previous submission attempt failed and could not be retried — please sign again.",
        );
      }
      await confirm.mutateAsync({ id: triggerId, orderIntentId: res.intentId });
      onClose();
    } catch (e) {
      setSignError(friendlySubmitError(e));
    }
  };

  // Popup identity: calm, payload-first — never slot-machine urgency.
  const loadFailed = Boolean(detail.error) && !d;
  const alreadyDone = d && d.trigger.status !== "awaiting_user";
  // W5: the worker executed this trigger unattended — the popup becomes the
  // receipt ("what happened") instead of a signing surface.
  const autoExecuted = Boolean(d?.trigger.autoExecutedAt);
  const autoFailed = d && !alreadyDone && d.trigger.autoFailedAt ? d.trigger : null;
  const headline = !d
    ? loadFailed
      ? "Couldn't load this trigger"
      : "Reviewing…"
    : autoExecuted
      ? "Executed automatically"
      : alreadyDone
        ? "Already handled"
        : d.fresh.isStale
          ? "Waiting for fresh data"
          : d.conditionStillHolds
            ? "Conditions met — order prepared"
            : "Price moved — review before signing";
  const headlineTone = !d
    ? loadFailed
      ? "text-warn"
      : "text-fg"
    : autoExecuted
      ? "text-pos"
      : alreadyDone || d.fresh.isStale
        ? "text-muted"
        : d.conditionStillHolds
          ? "text-pos"
          : "text-warn";

  const price = d ? Number(d.preview.price) : 0;
  const size = d ? Number(d.preview.size) : 0;
  const costUsd = d ? (d.preview.side === "BUY" ? price * size : (1 - price) * size) : 0;
  // BUY: shares pay $1 each if right, minus what was spent. SELL: keep the premium.
  const payoutUsd = d ? (d.preview.side === "BUY" ? size - costUsd : price * size) : 0;
  const askNow = bookQuote?.bestAsk ?? d?.fresh.bestAsk ?? null;
  const usd2 = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cents = (v: number) => `${Math.round(v * 100)}¢`;

  const rawSeries: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  const { series, spliced } = spliceLive(rawSeries, bookQuote, Date.now());
  const triggeredAtMs = d ? new Date(d.trigger.triggeredAt).getTime() : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Review triggered order"
    >
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className={cn("text-[15px] font-semibold", headlineTone)}>{headline}</h2>
          <button onClick={onClose} className="text-muted hover:text-fg" aria-label="Not now">
            ✕
          </button>
        </div>

        {loadFailed ? (
          <div className="space-y-3 text-xs">
            <div className="rounded-md border border-warn/40 bg-warn/10 p-3 text-warn">
              {(() => {
                const status = detail.error instanceof ApiError ? detail.error.status : 0;
                return status === 401 || status === 403
                  ? "Your session expired or you no longer have access — sign in again and reopen this from the bell."
                  : status === 404
                    ? "This trigger no longer exists — it may have expired or been cleaned up."
                    : "Something went wrong loading the prepared order.";
              })()}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void detail.refetch()}
                disabled={detail.isFetching}
              >
                {detail.isFetching ? "Retrying…" : "Retry"}
              </Button>
            </div>
          </div>
        ) : !d ? (
          <div className="space-y-3">
            {seed ? (
              <div className="space-y-1 text-xs">
                <div className="text-[15px] font-semibold text-fg">
                  {seed.action.side === "BUY" ? "Buy" : "Sell"}{" "}
                  {seed.action.sizeShares.toLocaleString()} shares
                </div>
                <div className="text-[12px] text-muted">
                  at {Math.round(Number(seed.action.price) * 100)}¢ limit · {seed.action.orderType}{" "}
                  · {seed.ruleName}
                </div>
              </div>
            ) : null}
            <Spinner label="Loading fresh preview…" />
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            {/* Dollars-first: what exactly is being approved. */}
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[15px] font-semibold text-fg">
                {d.preview.side === "BUY" ? "Buy" : "Sell"} {size.toLocaleString()} shares ·{" "}
                {usd2(costUsd)}
              </span>
              <span className="tabular text-[13px] font-medium text-pos">
                +{usd2(payoutUsd)} if right
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              <span>
                at {cents(price)} limit · {d.preview.orderType}
              </span>
              <span>max spend ${d.preview.maxSpend}</span>
              {askNow !== null ? (
                <span>
                  ask now <span className="tabular text-fg">{cents(Number(askNow))}</span>
                </span>
              ) : null}
              {d.fresh.dataAgeMs !== null && d.fresh.dataAgeMs !== undefined ? (
                <span>data {Math.round(Number(d.fresh.dataAgeMs) / 1000)}s old</span>
              ) : null}
            </div>

            {/* The live target market with the trigger moment marked. */}
            {series.length >= 2 ? (
              <AreaChart
                data={series}
                height={180}
                live={spliced}
                valueFormat={(v) => cents(v)}
                baselines={[{ value: price, label: `entry ${cents(price)}` }]}
                includeInDomain={[price]}
                markers={[{ t: triggeredAtMs, label: "T" }]}
              />
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <LiveCaption
                quote={bookQuote}
                {...(book.dataUpdatedAt ? { receivedAtMs: book.dataUpdatedAt } : {})}
              />
              <PolymarketLink conditionId={d.preview.conditionId} />
            </div>

            {/* Honest freshness line — PRICE_MOVED never dresses up as ready. */}
            {!alreadyDone && !d.conditionStillHolds ? (
              <div className="rounded-md border border-warn/40 bg-warn/10 p-2.5 text-warn">
                {d.fresh.isStale
                  ? "Latest market data is stale — the server won't call this ready until it's fresh."
                  : "The edge may have moved since the trigger — review the numbers before signing."}
              </div>
            ) : null}
            {autoFailed ? (
              <div className="rounded-md border border-warn/40 bg-warn/10 p-2.5 text-warn">
                Automatic execution failed (
                {autoFailureCopy(autoFailed.autoFailureReason ?? "unknown")}) — you can sign
                manually below.
              </div>
            ) : null}
            {autoExecuted ? (
              <div className="rounded-md border border-pos/40 bg-pos/10 p-2.5 text-pos">
                Submitted automatically from your Arima wallet
                {d.trigger.autoExecutedAt
                  ? ` at ${new Date(d.trigger.autoExecutedAt).toLocaleTimeString()}`
                  : ""}
                {d.trigger.orderIntentId
                  ? " — the order and its fills are in the strategy's activity."
                  : "."}
              </div>
            ) : alreadyDone ? (
              <div className="rounded-md border border-border bg-surface-2 p-2.5 text-muted">
                This trigger was already {d.trigger.status === "confirmed" ? "signed" : "closed"}
                {d.trigger.orderIntentId ? " — the order is in your activity." : "."}
              </div>
            ) : null}

            {/* Signing context (account select) — absent on executed receipts. */}
            {autoExecuted ? null : (
              <div className="space-y-1 rounded-md border border-border bg-surface-2 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-semibold text-fg">Signing wallet</span>
                  <Badge tone="warn">
                    {activeAccount?.signingMode === "browser"
                      ? "awaiting signature"
                      : "wallet pending"}
                  </Badge>
                </div>
                <select
                  value={activeAccount?.id ?? ""}
                  onChange={(e) => {
                    if (e.target.value) setPrimaryAccount.mutate(e.target.value);
                  }}
                  disabled={tradingAccounts.isLoading || setPrimaryAccount.isPending}
                  className="mb-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
                >
                  {accounts.length ? null : <option value="">No trading accounts</option>}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} · {shortAddress(account.signerAddress)}
                    </option>
                  ))}
                </select>
                {activeAccount?.signingMode === "browser" && !connectedMatchesActive ? (
                  <p className="text-warn">
                    Connect {address ? shortAddress(address) : "a wallet"} — the selected signer is
                    not the connected wallet.
                  </p>
                ) : null}
                {d.warning ? <p className="text-warn">{d.warning}</p> : null}
              </div>
            )}

            {/* De-emphasized: why it fired + advanced details. */}
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
            <details className="rounded-md border border-border bg-surface-2 p-3">
              <summary className="cursor-pointer font-semibold text-fg">
                Advanced execution details
              </summary>
              <div className="mt-2 space-y-1">
                <Row k="Builder code" v={d.preview.builderCode ?? "—"} mono />
                <Row k="Funder" v={funder || "—"} mono />
                <Row k="Trading account" v={activeAccount?.label ?? "—"} />
              </div>
            </details>

            {/* Single error banner — signAndSubmit's catch owns all failures
                (incl. the submit mutation via mutateAsync), so rendering
                submit.error here would duplicate every rejection. */}
            {signError ? <ErrorNote message={signError} /> : null}

            {autoExecuted ? (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="flex-1"
                  disabled={ack.isPending}
                  onClick={() => {
                    ack.mutate(triggerId);
                    onClose();
                  }}
                >
                  Dismiss
                </Button>
                <Link href={`/strategies/${d.trigger.ruleId}`} className="flex-1" onClick={onClose}>
                  <Button variant="outline" className="w-full">
                    View strategy
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={onClose}>
                  Not now
                </Button>
                <Link
                  href={`/strategies/${d.trigger.ruleId}/edit`}
                  className="flex-1"
                  onClick={onClose}
                >
                  <Button variant="outline" className="w-full">
                    Edit strategy
                  </Button>
                </Link>
                {!alreadyDone ? (
                  <Button
                    className="flex-1"
                    onClick={() => void signAndSubmit()}
                    disabled={
                      !tradingEnabled ||
                      submit.isPending ||
                      confirm.isPending ||
                      !selectedBrowserAccountReady
                    }
                    title={
                      !activeAccount
                        ? "Select a trading account first"
                        : activeAccount.signingMode !== "browser"
                          ? "Deposit-wallet no-signature trading is not active yet"
                          : !activeAccount.credentialsReady
                            ? "Set up trading credentials first"
                            : !connectedMatchesActive
                              ? "Connect the selected signer wallet"
                              : tradingEnabled
                                ? "Sign and submit"
                                : "Live trading is disabled on the server"
                    }
                  >
                    {submitButtonLabel}
                  </Button>
                ) : null}
              </div>
            )}
            <p className="text-[11px] text-muted">
              {autoExecuted
                ? "Dismiss clears this receipt from the bell — the order itself is untouched."
                : "Closing this keeps the item in the bell — nothing is lost, nothing is signed."}
            </p>
            {!tradingEnabled && !autoExecuted ? (
              <p className="text-muted">
                Live trading is disabled — submission is blocked fail-closed.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const fmtMs = (ms: number) => new Date(ms).toLocaleTimeString();

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{k}</span>
      <span className={cn("text-fg", mono && "tabular max-w-[60%] truncate")}>{v}</span>
    </div>
  );
}
