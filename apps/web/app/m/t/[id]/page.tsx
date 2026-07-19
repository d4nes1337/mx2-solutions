"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useConfirmTrigger,
  useDismissTrigger,
  useExchangeSignLink,
  useOrderbookByToken,
  useSubmitOrder,
  useTelegramMiniappAuth,
  useTriggerDetail,
} from "@/lib/queries";
import { getTelegramWebApp } from "@/lib/telegram";
import { ApiError } from "@/lib/api";
import { buildAndSignOrder, type Eip1193Provider } from "@/lib/order-sign";
import type { TriggerDetailResponse } from "@/lib/types";
import { Badge, Button, ErrorNote, Segmented, Spinner, cn } from "@/components/ui";
import { CheckDraw, FadeRise } from "@/components/motion/primitives";

/**
 * Mobile sign surface (opened from a Telegram notification, optionally inside
 * the Telegram webview). Auth: exchanges the single-use ?t= sign-link token
 * for a trigger-scoped session cookie, then strips the token from the URL.
 * The page shows the FRESH server preview, lets the user pick limit (rest at
 * a price) vs market (take now, FAK) and signs with the MAIN wallet via
 * WalletConnect/injected — the signature is the only thing that can execute.
 */

const MARKET_SLIPPAGE = 0.02; // cross up to 2¢ past the touch
const clampPrice = (p: number) => Math.min(0.99, Math.max(0.01, p));
const cents = (p: number | string | null | undefined): string => {
  const n = typeof p === "number" ? p : Number(p);
  return Number.isFinite(n) ? `${Math.round(n * 100)}¢` : "—";
};

export default function MobileSignPage() {
  return (
    <Suspense fallback={<Spinner label="Loading…" />}>
      <MobileSignInner />
    </Suspense>
  );
}

function MobileSignInner() {
  const params = useParams<{ id: string }>();
  const triggerId = params.id;
  const search = useSearchParams();
  const token = search.get("t");

  const exchange = useExchangeSignLink();
  const miniappAuth = useTelegramMiniappAuth();
  const [authReady, setAuthReady] = useState(false);

  // Auth, in preference order:
  //  1. ?t= sign-link token → exchange once, then scrub it from the URL (it
  //     must never survive in history/share sheets).
  //  2. Telegram Mini App initData (the web_app button carries no token) —
  //     the bridge script loads async, so poll briefly for it.
  //  3. An existing cookie from an earlier exchange (reload case).
  useEffect(() => {
    let cancelled = false;
    if (token) {
      exchange.mutate(token, {
        onSettled: () => {
          window.history.replaceState(null, "", window.location.pathname);
          if (!cancelled) setAuthReady(true);
        },
      });
      return () => {
        cancelled = true;
      };
    }
    const startedAt = Date.now();
    const detect = () => {
      if (cancelled) return;
      const tg = getTelegramWebApp();
      if (tg) {
        // Script loaded: inside Telegram initData is populated synchronously,
        // so empty initData means a plain browser — no need to keep waiting.
        if (tg.initData) {
          miniappAuth.mutate(tg.initData, {
            onSettled: () => {
              if (!cancelled) setAuthReady(true);
            },
          });
        } else {
          setAuthReady(true);
        }
        return;
      }
      // Only wait while the bridge script (injected by the /m layout) could
      // still be loading; without it Telegram can never appear.
      const scriptPresent = document.querySelector('script[src*="telegram-web-app"]') !== null;
      if (scriptPresent && Date.now() - startedAt < 1_500) {
        setTimeout(detect, 150);
        return;
      }
      setAuthReady(true); // cookie fallback
    };
    detect();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const detail = useTriggerDetail(authReady ? triggerId : null);

  if (!authReady || detail.isLoading) {
    return <Spinner label="Opening your prepared order…" />;
  }
  if (detail.error) {
    const status = detail.error instanceof ApiError ? detail.error.status : 0;
    return (
      <FadeRise>
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-fg">
          <div className="font-semibold">
            {status === 401 || status === 403 ? "Sign link expired" : "Could not load this order"}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            {status === 401 || status === 403
              ? "This link is single-use and expires after 30 minutes. Send /orders to the bot in Telegram to get a fresh link."
              : "Something went wrong loading the prepared order. Try again from the Telegram message."}
          </p>
        </div>
      </FadeRise>
    );
  }
  if (!detail.data) return <Spinner label="Loading…" />;
  return <SignCard triggerId={triggerId} d={detail.data} />;
}

function SignCard({ triggerId, d }: { triggerId: string; d: TriggerDetailResponse }) {
  const { address, connector } = useAccount();
  const submit = useSubmitOrder();
  const confirm = useConfirmTrigger();
  const dismiss = useDismissTrigger();
  const [signError, setSignError] = useState<string | null>(null);
  const [done, setDone] = useState<"signed" | "dismissed" | null>(null);

  const preview = d.preview;
  const account = d.account;
  const book = useOrderbookByToken(preview ? preview.tokenId : null);

  const [mode, setMode] = useState<"limit" | "market" | null>(null);
  const [limitCents, setLimitCents] = useState("");
  useEffect(() => {
    if (!preview || mode !== null) return;
    setMode(preview.orderType === "FAK" || preview.orderType === "FOK" ? "market" : "limit");
    setLimitCents(String(Math.round(Number(preview.price) * 100)));
  }, [preview, mode]);

  const bestAsk = useMemo(() => {
    const asks = book.data?.asks ?? [];
    return asks.length ? Math.min(...asks.map((l) => Number(l.price))) : null;
  }, [book.data]);
  const bestBid = useMemo(() => {
    const bids = book.data?.bids ?? [];
    return bids.length ? Math.max(...bids.map((l) => Number(l.price))) : null;
  }, [book.data]);

  if (!preview) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        This trigger has no order to sign (alert-only strategy).
      </div>
    );
  }

  const isBuy = preview.side === "BUY";
  // Market mode: take the touch with a small slippage cap; fall back to the
  // prepared price ± cap when the live book is unavailable.
  const marketPrice = clampPrice(
    isBuy
      ? (bestAsk ?? Number(preview.price)) + MARKET_SLIPPAGE
      : (bestBid ?? Number(preview.price)) - MARKET_SLIPPAGE,
  );
  const effPrice =
    mode === "market" ? marketPrice.toFixed(2) : (Number(limitCents || "0") / 100).toFixed(2);
  const effOrderType =
    mode === "market"
      ? ("FAK" as const)
      : preview.orderType === "GTC" || preview.orderType === "GTD"
        ? preview.orderType
        : ("GTC" as const);
  const estCost = (Number(effPrice) * Number(preview.size)).toFixed(2);

  const status = d.trigger.status;
  const connectedMatches =
    Boolean(address && account) && address!.toLowerCase() === account!.signerAddress.toLowerCase();
  const browserReady =
    account?.signingMode === "browser" && account.credentialsReady && connectedMatches;
  const limitValid = mode !== "limit" || (Number(limitCents) >= 1 && Number(limitCents) <= 99);

  const signAndSubmit = async () => {
    setSignError(null);
    if (!account) return setSignError("No trading account is set up for this wallet.");
    if (account.signingMode !== "browser") {
      return setSignError("This account signs server-side — use the desktop app.");
    }
    if (!account.credentialsReady) {
      return setSignError("Trading credentials are missing — set them up in the app first.");
    }
    if (!address || !connector) return setSignError("Connect your wallet first.");
    if (!connectedMatches) {
      return setSignError(
        `Connect the wallet ${short(account.signerAddress)} — it is this account's signer.`,
      );
    }
    if (!account.funderAddress) return setSignError("No funder configured for this account.");
    if (!limitValid) return setSignError("Limit price must be between 1¢ and 99¢.");
    try {
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const order = await buildAndSignOrder(provider, {
        tokenId: preview.tokenId,
        side: preview.side,
        price: effPrice,
        size: preview.size,
        funder: account.funderAddress,
        signer: account.signerAddress,
        builderCode: preview.builderCode,
        chainId: 137,
        // GTD entry window (server-computed wire expiration) applies to the
        // resting path only; a market take has no expiration.
        ...(mode === "limit" && preview.expiration ? { expiration: preview.expiration } : {}),
        negRisk: false,
      });
      const res = await submit.mutateAsync({
        tradingAccountId: account.id,
        idempotencyKey: `trigger:${triggerId}`,
        conditionId: preview.conditionId,
        price: effPrice,
        size: preview.size,
        orderType: effOrderType,
        postOnly: mode === "limit" ? preview.postOnly : false,
        order,
      });
      await confirm.mutateAsync({ id: triggerId, orderIntentId: res.intentId });
      setDone("signed");
    } catch (e) {
      setSignError(e instanceof Error ? e.message : "Signing failed.");
    }
  };

  if (done === "signed") {
    return (
      <FadeRise>
        <div className="flex flex-col items-center gap-3 rounded-lg border border-pos/40 bg-pos/10 p-6 text-center">
          <CheckDraw size={56} className="text-pos" />
          <div className="text-sm font-semibold text-fg">Order signed & submitted</div>
          <p className="text-[13px] text-muted">
            {preview.side} {preview.size} @ {cents(effPrice)} · {effOrderType}. You can close this
            page — fills will arrive as Telegram notifications.
          </p>
        </div>
      </FadeRise>
    );
  }
  if (done === "dismissed" || status === "dismissed") {
    return <StatusNote text="This prepared order was dismissed. Nothing was submitted." />;
  }
  if (status === "confirmed") {
    return <StatusNote text="This order was already signed and submitted." />;
  }
  if (status === "expired") {
    return <StatusNote text="This prepared order expired before it was signed." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-fg">Order ready to sign</div>
        <Badge tone="warn">awaiting signature</Badge>
      </div>

      {/* Does the condition still hold right now? */}
      <div
        className={cn(
          "rounded-lg border p-3 text-[13px]",
          d.conditionStillHolds
            ? "border-pos/40 bg-pos/10 text-pos"
            : "border-warn/40 bg-warn/10 text-warn",
        )}
      >
        <span className="font-semibold">
          {d.conditionStillHolds ? "Condition still holds" : "⚠ Condition no longer holds"}
        </span>
        {!d.conditionStillHolds ? (
          <span> — the edge may have moved since the trigger. Review before signing.</span>
        ) : null}
      </div>

      {/* The order */}
      <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
        <div className="flex items-baseline justify-between">
          <span className={cn("text-base font-semibold tabular", isBuy ? "text-pos" : "text-neg")}>
            {preview.side} {preview.size}
          </span>
          <span className="text-base font-semibold tabular text-fg">{cents(effPrice)}</span>
        </div>
        <div className="flex justify-between text-[12px] text-muted">
          <span>
            Book: {cents(bestBid)} / {cents(bestAsk)}
          </span>
          <span>
            Est. {isBuy ? "cost" : "proceeds"} ${estCost}
          </span>
        </div>

        {mode !== null ? (
          <Segmented
            grow
            options={[
              { value: "limit" as const, label: "Limit" },
              { value: "market" as const, label: "Market" },
            ]}
            value={mode}
            onChange={(v) => setMode(v)}
          />
        ) : null}

        {mode === "limit" ? (
          <label className="flex items-center justify-between gap-3 text-[13px] text-muted">
            Limit price (¢)
            <input
              inputMode="numeric"
              value={limitCents}
              onChange={(e) => setLimitCents(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
              className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-right text-sm tabular text-fg outline-none focus:border-accent/50"
            />
          </label>
        ) : (
          <p className="text-[12px] text-muted">
            Takes what the book offers now ({effOrderType}), filling {isBuy ? "up" : "down"} to{" "}
            {cents(effPrice)}; any unfilled remainder is cancelled.
          </p>
        )}
        <div className="flex justify-between text-[12px] text-muted">
          <span>Order type</span>
          <span className="text-fg">{effOrderType}</span>
        </div>
        <p className="text-[11px] leading-relaxed text-warn">{d.warning}</p>
      </div>

      {/* Wallet connection state */}
      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="mb-2 flex items-center justify-between text-[12px] text-muted">
          <span>Signing wallet</span>
          <span className="tabular text-fg">{account ? short(account.signerAddress) : "—"}</span>
        </div>
        <ConnectButton
          chainStatus="none"
          accountStatus="address"
          showBalance={false}
          label="Connect wallet to sign"
        />
        {address && !connectedMatches ? (
          <p className="mt-2 text-[12px] text-warn">
            Connected {short(address)} — switch to {account ? short(account.signerAddress) : "—"} to
            sign this order.
          </p>
        ) : null}
      </div>

      {signError ? <ErrorNote message={signError} /> : null}

      <div className="flex gap-2">
        <Button
          variant="ghost"
          className="flex-1"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate(triggerId, { onSuccess: () => setDone("dismissed") })}
        >
          Dismiss
        </Button>
        <Button
          className="flex-1"
          disabled={
            !d.tradingEnabled ||
            !browserReady ||
            !limitValid ||
            submit.isPending ||
            confirm.isPending
          }
          onClick={() => void signAndSubmit()}
        >
          {submit.isPending || confirm.isPending
            ? "Signing…"
            : !d.tradingEnabled
              ? "Trading disabled"
              : !browserReady
                ? "Connect signer wallet"
                : "Sign & submit"}
        </Button>
      </div>
      {!d.tradingEnabled ? (
        <p className="text-[12px] text-muted">
          Live trading is disabled on the server — submission is blocked fail-closed.
        </p>
      ) : null}
    </div>
  );
}

function StatusNote({ text }: { text: string }) {
  return (
    <FadeRise>
      <div className="rounded-lg border border-border bg-surface p-4 text-[13px] text-muted">
        {text}
      </div>
    </FadeRise>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
