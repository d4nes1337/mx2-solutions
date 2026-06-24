"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import {
  useOrderPreview,
  useSetupCredentials,
  useSubmitOrder,
  useTradeStatus,
} from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { buildPreviewRequest } from "@/lib/orders";
import { buildAndSignOrder, type Eip1193Provider } from "@/lib/order-sign";
import { signClobAuth } from "@/lib/clob-auth";
import type { OrderSide } from "@/lib/types";
import { Badge, Button, ErrorNote, cn } from "./ui";

// Order ticket: preview → sign → submit. Preview (POST /api/trade/orders/preview)
// is always available. Submission builds + signs the full CTF Exchange order with
// the EOA (signatureType 2; maker = the derived deposit wallet), then POSTs the
// signed struct. The backend still gates submission behind FEATURE_LIVE_TRADING +
// kill switch + geoblock, so submit stays disabled until trading is enabled.
export function OrderTicket({
  conditionId,
  tokenIds,
  outcomes,
  negRisk,
  isStale,
  signedIn,
}: {
  conditionId: string;
  tokenIds: string[];
  outcomes: string[];
  negRisk: boolean;
  isStale: boolean;
  signedIn: boolean;
}) {
  const { address, connector } = useAccount();
  const session = useSession();
  const tradeStatus = useTradeStatus();
  const preview = useOrderPreview();
  const submit = useSubmitOrder();
  const setupCreds = useSetupCredentials();

  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const [side, setSide] = useState<OrderSide>("BUY");
  const [price, setPrice] = useState("0.50");
  const [size, setSize] = useState("10");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);

  const tokenId = tokenIds[outcomeIdx];
  // The order maker / source of funds is the deposit (Safe) wallet, not the EOA.
  const funder = session.data?.depositWallet ?? "";

  const canPreview = signedIn && !isStale && Boolean(conditionId);
  const tradingEnabled = tradeStatus.data?.tradingEnabled === true;

  const submitPreview = () => {
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
    setSignError(null);
    submit.reset();
    preview.mutate(built.request);
  };

  const signAndSubmit = async () => {
    setSignError(null);
    if (!address || !connector) {
      setSignError("Connect a wallet first.");
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
        signer: address,
        builderCode: preview.data?.builderCode,
        chainId: 137,
        negRisk,
      });
      submit.mutate({
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

  const [setupError, setSetupError] = useState<string | null>(null);
  const setupTradingCredentials = async () => {
    setSetupError(null);
    if (!address || !connector) {
      setSetupError("Connect a wallet first.");
      return;
    }
    try {
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const auth = await signClobAuth(provider, address, 137);
      setupCreds.mutate(auth);
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : "Signing failed.");
    }
  };

  const previewError =
    preview.error instanceof ApiError
      ? preview.error
      : preview.error instanceof Error
        ? { status: 0, message: preview.error.message }
        : null;

  const submitError =
    submit.error instanceof ApiError
      ? submit.error
      : submit.error instanceof Error
        ? { status: 0, message: submit.error.message }
        : null;

  return (
    <div className="space-y-3">
      {/* Outcome selector */}
      <div className="flex gap-2">
        {(outcomes.length ? outcomes : ["YES", "NO"]).map((label, i) => (
          <button
            key={i}
            onClick={() => setOutcomeIdx(i)}
            disabled={!tokenIds[i]}
            className={cn(
              "flex-1 rounded-md border px-2 py-1.5 text-sm transition-colors disabled:opacity-30",
              outcomeIdx === i
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-border text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>

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

      <Button
        className="w-full"
        onClick={submitPreview}
        disabled={!canPreview || preview.isPending}
      >
        {preview.isPending ? "Previewing…" : "Preview order"}
      </Button>

      {!signedIn ? (
        <p className="text-xs text-muted">Sign in to preview an order.</p>
      ) : isStale ? (
        <p className="text-xs text-warn">
          Orderbook is stale — preview is held back (fail-closed).
        </p>
      ) : null}

      {validationError ? <ErrorNote message={validationError} /> : null}

      {previewError ? (
        <ErrorNote
          message={
            previewError.status === 403
              ? "Geoblocked: order preview is not available from your region."
              : previewError.message
          }
        />
      ) : null}

      {preview.data ? (
        <div className="space-y-1 rounded-md border border-border bg-surface-2 p-3 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold text-fg">Order preview</span>
            {submit.data ? (
              <Badge tone="pos">{submit.data.status}</Badge>
            ) : (
              <Badge tone="warn">not submitted</Badge>
            )}
          </div>
          <Row
            k="Side / outcome"
            v={`${preview.data.side} · ${outcomes[outcomeIdx] ?? `#${outcomeIdx}`}`}
          />
          <Row k="Price" v={preview.data.price} />
          <Row k="Size" v={preview.data.size} />
          <Row k="Max spend" v={`$${preview.data.maxSpend}`} />
          <Row k="Order type" v={preview.data.orderType} />
          <Row k="Signature type" v={`${preview.data.signatureType} (Gnosis Safe)`} />
          <Row k="Funder (deposit)" v={preview.data.funder} mono />
          <Row k="Builder code" v={preview.data.builderCode ?? "—"} mono />
          {submit.data?.clobOrderId ? (
            <Row k="CLOB order id" v={submit.data.clobOrderId} mono />
          ) : null}
          <p className="mt-2 text-muted">{preview.data.note}</p>
          <p className="text-warn">{preview.data.warning}</p>
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
                  ? "No trading credentials yet — click “Set up trading credentials” below first."
                  : submitError.message
          }
        />
      ) : null}

      {/* One-time CLOB credential setup. Signs the L1 ClobAuth message so the
          backend can derive your L2 API key. Only needed once per wallet. */}
      {signedIn && tradingEnabled ? (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            className="flex-1"
            onClick={() => void setupTradingCredentials()}
            disabled={setupCreds.isPending || setupCreds.isSuccess}
            title="Sign once to derive your CLOB API credentials"
          >
            {setupCreds.isPending
              ? "Check wallet…"
              : setupCreds.isSuccess
                ? "Trading credentials ready ✓"
                : "Set up trading credentials"}
          </Button>
        </div>
      ) : null}
      {setupError ? <ErrorNote message={setupError} /> : null}
      {setupCreds.error ? (
        <ErrorNote
          message={`Credential setup failed: ${
            setupCreds.error instanceof Error ? setupCreds.error.message : "unknown error"
          }`}
        />
      ) : null}

      <Button
        className="w-full"
        onClick={() => void signAndSubmit()}
        disabled={!preview.data || !tradingEnabled || submit.isPending || Boolean(submit.data)}
        title={
          tradingEnabled ? "Sign and submit this order" : "Live trading is disabled on the server"
        }
      >
        {submit.isPending
          ? "Signing & submitting…"
          : submit.data
            ? "Submitted"
            : tradingEnabled
              ? "Sign & submit order"
              : "Submit (trading disabled)"}
      </Button>
      {preview.data && !tradingEnabled ? (
        <p className="text-xs text-muted">
          Preview is signable, but the server has live trading disabled — submission is blocked
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
