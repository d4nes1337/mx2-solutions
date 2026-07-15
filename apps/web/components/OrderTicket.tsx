"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { Wallet } from "lucide-react";
import {
  useSetPrimaryTradingAccount,
  useSubmitOrder,
  useTradeStatus,
  useTradingAccounts,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { signedUsd } from "@/lib/format";
import { buildPreviewRequest } from "@/lib/orders";
import { buildAndSignOrder, type Eip1193Provider } from "@/lib/order-sign";
import { computePayoff } from "@/lib/smart-orders/projection";
import type { OrderSide } from "@/lib/types";
import { Badge, Button, ErrorNote, cn } from "./ui";

// Order ticket: sign → submit, with everything the old Preview round-trip used
// to show (position value, payoff-if-fills) computed inline as you type.
// Submission builds + signs the full CTF Exchange order with the EOA
// (signatureType 2; maker = the derived deposit wallet), then POSTs the signed
// struct. The backend still gates submission behind FEATURE_LIVE_TRADING +
// kill switch + geoblock, so submit stays disabled until trading is enabled.
// The builder attribution code comes from GET /api/trade/status.
//
// Wallet *management* (add/activate/credentials) lives in the Profile page's
// WalletsSection — this ticket only shows the active wallet + a quick-switch.
export function OrderTicket({
  conditionId,
  tokenIds,
  outcomes,
  negRisk,
  isStale,
  signedIn,
  outcomeIdx,
  prefill,
  currentPrice,
}: {
  conditionId: string;
  tokenIds: string[];
  outcomes: string[];
  negRisk: boolean;
  isStale: boolean;
  signedIn: boolean;
  /** Controlled by the page's outcome selector (chart + book + ticket stay in sync). */
  outcomeIdx: number;
  /** Click-to-trade from the order book; bump `nonce` to re-apply. */
  prefill?: { price?: string; size?: string; side?: OrderSide; nonce: number };
  /** Live mid/probability for the selected outcome (payoff mark-to-market). */
  currentPrice?: number | null;
}) {
  const { address, connector } = useAccount();
  const tradeStatus = useTradeStatus();
  const tradingAccounts = useTradingAccounts(signedIn);
  const setPrimaryAccount = useSetPrimaryTradingAccount();
  const submit = useSubmitOrder();

  const [side, setSide] = useState<OrderSide>("BUY");
  const [price, setPrice] = useState("0.50");
  const [size, setSize] = useState("10");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);

  useEffect(() => {
    if (!prefill) return;
    if (prefill.price != null) setPrice(prefill.price);
    if (prefill.size != null) setSize(prefill.size);
    if (prefill.side) setSide(prefill.side);
    setValidationError(null);
    submit.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const tokenId = tokenIds[outcomeIdx];
  const accounts = tradingAccounts.data?.accounts ?? [];
  const activeAccount = tradingAccounts.data?.primaryAccount ?? null;
  const funder = activeAccount?.funderAddress ?? "";
  const connectedMatchesActive =
    Boolean(address && activeAccount) &&
    address!.toLowerCase() === activeAccount!.signerAddress.toLowerCase();
  const walletReady = activeAccount
    ? activeAccount.signingMode === "browser"
      ? activeAccount.credentialsReady && connectedMatchesActive
      : activeAccount.status === "ready"
    : false;

  const tradingEnabled = tradeStatus.data?.tradingEnabled === true;
  const priceNum = Number(price);
  const sizeNum = Number(size);
  const inputsValid = priceNum > 0 && priceNum < 1 && sizeNum > 0;
  const selectedBrowserAccountReady =
    activeAccount?.signingMode === "browser" &&
    activeAccount.credentialsReady &&
    connectedMatchesActive;
  const serverWalletBlockedReason =
    activeAccount?.signingMode !== "browser"
      ? activeAccount?.status === "needs_deposit_wallet"
        ? "Activate your trading account on the Profile page →"
        : activeAccount?.status === "needs_funding"
          ? "Fund your trading wallet on the Profile page →"
          : "Complete wallet setup on the Profile page →"
      : null;
  const submitBlockedReason = !activeAccount
    ? "Select a trading account first"
    : serverWalletBlockedReason
      ? serverWalletBlockedReason
      : !activeAccount.credentialsReady
        ? "Set up trading credentials first"
        : !connectedMatchesActive
          ? "Connect the selected signer wallet"
          : !tradingEnabled
            ? "Live trading is disabled on the server"
            : null;
  const submitButtonLabel = submit.isPending
    ? "Signing & submitting…"
    : submit.data
      ? "Submitted"
      : !activeAccount
        ? "Select wallet"
        : activeAccount.signingMode !== "browser"
          ? activeAccount.status === "needs_deposit_wallet"
            ? "Wallet not activated"
            : activeAccount.status === "needs_funding"
              ? "Wallet not funded"
              : "Wallet setup incomplete"
          : !activeAccount.credentialsReady
            ? "Credentials needed"
            : !connectedMatchesActive
              ? "Connect selected wallet"
              : tradingEnabled
                ? "Sign & submit order"
                : "Submit (trading disabled)";

  const signAndSubmit = async () => {
    setSignError(null);
    // Same client-side validation the preview round-trip used to run.
    const built = buildPreviewRequest({
      conditionId,
      tokenId,
      side,
      price,
      size,
      orderType: "GTC",
      funder,
    });
    if (!built.ok) {
      setValidationError(built.error);
      return;
    }
    setValidationError(null);
    if (!activeAccount) {
      setSignError("Select a trading account first.");
      return;
    }
    if (activeAccount.signingMode !== "browser") {
      setSignError("This trading account is not ready for no-signature live orders yet.");
      return;
    }
    if (!activeAccount.credentialsReady) {
      setSignError("Set up trading credentials for this wallet first.");
      return;
    }
    if (!address || !connector) {
      setSignError("Connect a wallet first.");
      return;
    }
    if (address.toLowerCase() !== activeAccount.signerAddress.toLowerCase()) {
      setSignError("Switch your connected wallet to the selected trading account before signing.");
      return;
    }
    if (!tokenId || !funder) {
      setSignError("Missing token id or deposit wallet.");
      return;
    }
    try {
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const order = await buildAndSignOrder(provider, {
        tokenId,
        side,
        price,
        size,
        funder,
        signer: activeAccount.signerAddress,
        builderCode: tradeStatus.data?.builderCode ?? undefined,
        chainId: 137,
        negRisk,
      });
      submit.mutate({
        tradingAccountId: activeAccount.id,
        idempotencyKey: crypto.randomUUID(),
        conditionId,
        price,
        size,
        orderType: "GTC",
        order,
      });
    } catch (e) {
      // User rejection or signing failure — surface, don't submit.
      setSignError(e instanceof Error ? e.message : "Signing failed.");
    }
  };

  const submitError =
    submit.error instanceof ApiError
      ? submit.error
      : submit.error instanceof Error
        ? { status: 0, message: submit.error.message }
        : null;

  return (
    <div className="space-y-3">
      {/* Wallet summary — full management lives in Profile → WalletsSection. */}
      {signedIn ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-2 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Wallet size={14} className="shrink-0" />
              <span className="truncate font-medium text-fg">
                {activeAccount?.label ?? "No trading wallet"}
              </span>
              {activeAccount ? (
                <span className="tabular shrink-0 text-[11px] text-muted">
                  {shortAddress(activeAccount.signerAddress)}
                </span>
              ) : null}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <Badge tone={tradingEnabled ? "pos" : "warn"} dot>
                {tradingEnabled ? "live" : "live off"}
              </Badge>
              {activeAccount ? (
                <Badge tone={walletReady ? "pos" : "warn"}>{walletReady ? "ready" : "setup"}</Badge>
              ) : null}
            </div>
          </div>

          {accounts.length > 1 ? (
            <select
              value={activeAccount?.id ?? ""}
              onChange={(e) => {
                if (e.target.value) setPrimaryAccount.mutate(e.target.value);
              }}
              disabled={setPrimaryAccount.isPending}
              aria-label="Switch trading wallet"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} · {shortAddress(account.signerAddress)}
                </option>
              ))}
            </select>
          ) : null}

          {!activeAccount || !walletReady ? (
            <p className="text-[11px] text-muted">
              {accounts.length === 0 ? "No trading wallet yet." : "This wallet needs setup."}{" "}
              <Link href="/profile" className="font-medium text-accent underline">
                Manage in Profile →
              </Link>
            </p>
          ) : (
            <div className="flex justify-end">
              <Link href="/profile" className="text-[11px] font-medium text-accent hover:text-fg">
                Manage wallets →
              </Link>
            </div>
          )}
        </div>
      ) : null}

      {/* Side */}
      <div className="flex gap-2">
        {(["BUY", "SELL"] as OrderSide[]).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={cn(
              "flex-1 rounded-md border px-2 py-1.5 text-sm transition-colors",
              side === s
                ? s === "BUY"
                  ? "border-pos/50 bg-pos/15 text-pos"
                  : "border-neg/50 bg-neg/15 text-neg"
                : "border-border text-muted hover:text-fg",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Price + size */}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          Price (0–1)
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            className="tabular mt-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
          />
        </label>
        <label className="block text-xs text-muted">
          Size (shares)
          <input
            value={size}
            onChange={(e) => setSize(e.target.value)}
            inputMode="decimal"
            className="tabular mt-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
          />
        </label>
      </div>

      {Number(price) > 0 && Number(size) > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-2/50 px-2.5 py-1.5 text-[11px]">
            <span className="text-muted">Position value</span>
            <span className="tabular font-semibold text-fg">
              ${(Number(price) * Number(size)).toFixed(2)}
            </span>
          </div>
          {(() => {
            const p = Number(price);
            const s = Number(size);
            if (!(p > 0 && p < 1) || !(s > 0)) return null;
            const payoff = computePayoff({
              side,
              price: p,
              size: s,
              tokenId: tokenIds[outcomeIdx] ?? "",
              outcome: outcomes[outcomeIdx] ?? "YES",
              currentPrice: currentPrice ?? null,
              hypothetical: false,
            });
            const outcome = outcomes[outcomeIdx] ?? "YES";
            return (
              <div className="flex items-center justify-between rounded-md border border-border bg-surface-2/50 px-2.5 py-1.5 text-[11px]">
                <span className="text-muted">If it fills (estimate)</span>
                <span className="tabular font-semibold">
                  <span className={payoff.payoffIfWinUsd >= 0 ? "text-pos" : "text-neg"}>
                    {signedUsd(payoff.payoffIfWinUsd)}
                  </span>{" "}
                  <span className="text-faint">if {outcome} wins ·</span>{" "}
                  <span className={payoff.payoffIfLoseUsd >= 0 ? "text-pos" : "text-neg"}>
                    {signedUsd(payoff.payoffIfLoseUsd)}
                  </span>{" "}
                  <span className="text-faint">if not</span>
                </span>
              </div>
            );
          })()}
        </div>
      ) : null}

      {!signedIn ? (
        <p className="text-xs text-muted">Sign in to trade.</p>
      ) : isStale ? (
        <p className="text-xs text-warn">
          Orderbook is stale — trading is held back (fail-closed).
        </p>
      ) : null}

      {validationError ? <ErrorNote message={validationError} /> : null}

      {submit.data ? (
        <div className="celebrate space-y-1 rounded-md border border-pos/50 bg-surface-2 p-3 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold text-fg">✓ Order submitted</span>
            <Badge tone="pos">{submit.data.status}</Badge>
          </div>
          <Row k="Side / outcome" v={`${side} · ${outcomes[outcomeIdx] ?? `#${outcomeIdx}`}`} />
          <Row k="Price" v={price} />
          <Row k="Size" v={size} />
          {submit.data.clobOrderId ? (
            <Row k="CLOB order id" v={submit.data.clobOrderId} mono />
          ) : null}
        </div>
      ) : null}

      {/* Server wallet setup hint */}
      {activeAccount?.signingMode !== "browser" && signedIn ? (
        <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {activeAccount?.status === "needs_deposit_wallet"
            ? "Activate your trading account first."
            : activeAccount?.status === "needs_funding"
              ? "Fund your trading wallet with USDC."
              : "Complete wallet setup."}{" "}
          <Link href="/profile" className="font-medium underline">
            Go to Profile →
          </Link>
        </div>
      ) : null}

      {signError ? <ErrorNote message={signError} /> : null}
      {submitError ? (
        <ErrorNote
          message={
            submitError.status === 503
              ? "Trading is disabled (live-trading flag off or paused) — order not submitted."
              : submitError.status === 403
                ? "Geoblocked: order submission is not available from your region."
                : submitError.message.includes("CLOB_CREDENTIALS_NOT_SET")
                  ? "No trading credentials yet — set them up in Profile first."
                  : submitError.message
          }
        />
      ) : null}

      <Button
        className="w-full"
        onClick={() => void signAndSubmit()}
        disabled={
          !signedIn ||
          !inputsValid ||
          isStale ||
          !tradingEnabled ||
          submit.isPending ||
          Boolean(submit.data) ||
          !selectedBrowserAccountReady
        }
        title={submitBlockedReason ?? "Sign and submit this order"}
      >
        {submitButtonLabel}
      </Button>
      {signedIn && inputsValid && !tradingEnabled ? (
        <p className="text-xs text-muted">
          The order is signable, but the server has live trading disabled — submission is blocked
          fail-closed.
        </p>
      ) : null}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{k}</span>
      <span className={cn("text-fg", mono && "tabular max-w-[60%] truncate")}>{v}</span>
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
