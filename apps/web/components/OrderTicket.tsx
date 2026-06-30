"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { Check, KeyRound, Plus, RefreshCcw, Wallet, Zap } from "lucide-react";
import {
  useActivateDepositWallet,
  useOrderPreview,
  useSetupCredentials,
  useSetPrimaryTradingAccount,
  useSubmitOrder,
  useTradeStatus,
  useTradingAccounts,
  useUpsertExternalTradingAccount,
} from "@/lib/queries";
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
  const tradeStatus = useTradeStatus();
  const tradingAccounts = useTradingAccounts(signedIn);
  const setPrimaryAccount = useSetPrimaryTradingAccount();
  const addExternalAccount = useUpsertExternalTradingAccount();
  const activateDepositWallet = useActivateDepositWallet();
  const preview = useOrderPreview();
  const submit = useSubmitOrder();
  const setupCreds = useSetupCredentials();

  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const [side, setSide] = useState<OrderSide>("BUY");
  const [price, setPrice] = useState("0.50");
  const [size, setSize] = useState("10");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [addWalletOpen, setAddWalletOpen] = useState(false);
  const [newWalletAddress, setNewWalletAddress] = useState("");
  const [newWalletFunder, setNewWalletFunder] = useState("");
  const [newWalletLabel, setNewWalletLabel] = useState("");
  const [addWalletError, setAddWalletError] = useState<string | null>(null);

  const tokenId = tokenIds[outcomeIdx];
  const accounts = tradingAccounts.data?.accounts ?? [];
  const activeAccount = tradingAccounts.data?.primaryAccount ?? null;
  const connectedAccountAlreadyAdded = accounts.some(
    (account) => address && account.signerAddress.toLowerCase() === address.toLowerCase(),
  );
  const funder = activeAccount?.funderAddress ?? "";
  const connectedMatchesActive =
    Boolean(address && activeAccount) &&
    address!.toLowerCase() === activeAccount!.signerAddress.toLowerCase();
  const browserWalletMismatch =
    activeAccount?.signingMode === "browser" && (!address || !connectedMatchesActive);

  const accountCanPreview =
    activeAccount?.signingMode === "browser" ||
    (activeAccount?.signingMode === "server" && activeAccount.status === "ready");
  const canPreview = signedIn && !isStale && Boolean(conditionId) && Boolean(activeAccount);
  const tradingEnabled = tradeStatus.data?.tradingEnabled === true;
  const selectedBrowserAccountReady =
    activeAccount?.signingMode === "browser" &&
    activeAccount.credentialsReady &&
    connectedMatchesActive;
  const submitBlockedReason = !activeAccount
    ? "Select a trading account first"
    : activeAccount.signingMode !== "browser"
      ? "Deposit-wallet no-signature trading is not active yet"
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
          ? "No-signature wallet pending"
          : !activeAccount.credentialsReady
            ? "Credentials needed"
            : !connectedMatchesActive
              ? "Connect selected wallet"
              : tradingEnabled
                ? "Sign & submit order"
                : "Submit (trading disabled)";

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
    preview.mutate({ ...built.request, tradingAccountId: activeAccount?.id });
  };

  const signAndSubmit = async () => {
    setSignError(null);
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
        builderCode: preview.data?.builderCode,
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

  const [setupError, setSetupError] = useState<string | null>(null);
  const addWallet = () => {
    setAddWalletError(null);
    const signerAddress = newWalletAddress.trim() || address || "";
    if (!signerAddress) {
      setAddWalletError("Enter a wallet address or connect one.");
      return;
    }
    addExternalAccount.mutate(
      {
        address: signerAddress,
        funderAddress: newWalletFunder.trim() || undefined,
        label: newWalletLabel.trim() || undefined,
        makePrimary: true,
      },
      {
        onSuccess: () => {
          setNewWalletAddress("");
          setNewWalletFunder("");
          setNewWalletLabel("");
          setAddWalletOpen(false);
        },
      },
    );
  };

  const setupTradingCredentials = async () => {
    setSetupError(null);
    if (!activeAccount) {
      setSetupError("Select a trading account first.");
      return;
    }
    if (!address || !connector) {
      setSetupError("Connect a wallet first.");
      return;
    }
    if (address.toLowerCase() !== activeAccount.signerAddress.toLowerCase()) {
      setSetupError("Switch your connected wallet to the selected trading account first.");
      return;
    }
    try {
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const auth = await signClobAuth(provider, activeAccount.signerAddress, 137);
      setupCreds.mutate({ ...auth, tradingAccountId: activeAccount.id });
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
      {signedIn ? (
        <div className="space-y-3 rounded-md border border-border bg-surface-2 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold text-fg">
              <Wallet size={14} />
              Trading wallet
            </span>
            <div className="flex items-center gap-1">
              <Badge tone={tradingEnabled ? "pos" : "warn"} dot>
                {tradingEnabled ? "live" : "live off"}
              </Badge>
              {activeAccount ? (
                <Badge tone={activeAccount.signingMode === "browser" ? "warn" : "pos"}>
                  {activeAccount.signingMode === "browser" ? "signature" : "no-popup"}
                </Badge>
              ) : null}
            </div>
          </div>
          <select
            value={activeAccount?.id ?? ""}
            onChange={(e) => {
              if (e.target.value) setPrimaryAccount.mutate(e.target.value);
            }}
            disabled={tradingAccounts.isLoading || setPrimaryAccount.isPending}
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
          >
            {tradingAccounts.data?.accounts.length ? null : (
              <option value="">No trading accounts</option>
            )}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label} · {shortAddress(account.signerAddress)}
              </option>
            ))}
          </select>

          {accounts.length ? (
            <div className="space-y-1">
              {accounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => setPrimaryAccount.mutate(account.id)}
                  disabled={setPrimaryAccount.isPending || account.isPrimary}
                  className={cn(
                    "w-full rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-default",
                    account.isPrimary
                      ? "border-accent/40 bg-accent/10"
                      : "border-border bg-surface hover:border-border-strong",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-fg">{account.label}</div>
                      <div className="tabular mt-0.5 text-[11px] text-muted">
                        {shortAddress(account.signerAddress)}
                        {account.funderAddress ? ` -> ${shortAddress(account.funderAddress)}` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {account.isPrimary ? (
                        <Badge tone="accent" className="gap-1">
                          <Check size={11} />
                          primary
                        </Badge>
                      ) : null}
                      <Badge tone={account.signingMode === "browser" ? "warn" : "pos"}>
                        {account.signingMode === "browser" ? "sign" : "auto"}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {statusLabel(account.status, account.nextAction)}
                    {account.credentialsReady ? " · credentials ready" : ""}
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          {activeAccount ? (
            <div className="space-y-1">
              <Row k="Signer" v={shortAddress(activeAccount.signerAddress)} />
              <Row
                k="Funder"
                v={
                  activeAccount.funderAddress
                    ? shortAddress(activeAccount.funderAddress)
                    : "activation needed"
                }
              />
              <Row k="Status" v={statusLabel(activeAccount.status, activeAccount.nextAction)} />
              {activeAccount.signingMode === "browser" ? (
                <Row
                  k="Connected"
                  v={
                    connectedMatchesActive
                      ? "selected signer"
                      : address
                        ? shortAddress(address)
                        : "not connected"
                  }
                />
              ) : null}
              {browserWalletMismatch ? (
                <p className="text-warn">
                  Connect {shortAddress(activeAccount.signerAddress)} before credential setup or
                  order signing.
                </p>
              ) : null}
              {activeAccount.kind === "internal_privy" && activeAccount.status !== "ready" ? (
                <p className="text-warn">
                  Internal no-signature trading needs Polymarket deposit-wallet activation before
                  orders can use this account.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-muted">Initializing wallet choices…</p>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {address && connectedAccountAlreadyAdded === false ? (
              <Button
                variant="ghost"
                className="w-full"
                disabled={addExternalAccount.isPending}
                onClick={() =>
                  addExternalAccount.mutate({
                    address,
                    label: "External Polymarket wallet",
                    makePrimary: true,
                  })
                }
              >
                <Wallet size={14} />
                {addExternalAccount.isPending ? "Adding…" : "Use connected"}
              </Button>
            ) : null}
            <Button variant="ghost" className="w-full" onClick={() => setAddWalletOpen((v) => !v)}>
              <Plus size={14} />
              Add wallet
            </Button>
          </div>

          {addWalletOpen ? (
            <div className="space-y-2 rounded-md border border-border bg-surface p-2">
              <input
                value={newWalletAddress}
                onChange={(e) => setNewWalletAddress(e.target.value)}
                placeholder={address ? `Signer, blank = ${shortAddress(address)}` : "Signer 0x..."}
                className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
              />
              <input
                value={newWalletFunder}
                onChange={(e) => setNewWalletFunder(e.target.value)}
                placeholder="Polymarket wallet/proxy 0x... (optional)"
                className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
              />
              <input
                value={newWalletLabel}
                onChange={(e) => setNewWalletLabel(e.target.value)}
                placeholder="Label (optional)"
                className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-fg outline-none focus:border-accent/50"
              />
              <Button
                className="w-full"
                disabled={addExternalAccount.isPending}
                onClick={addWallet}
              >
                <Plus size={14} />
                {addExternalAccount.isPending ? "Saving…" : "Save and use wallet"}
              </Button>
              {addWalletError ? <ErrorNote message={addWalletError} /> : null}
            </div>
          ) : null}

          {addExternalAccount.error ? (
            <ErrorNote
              message={
                addExternalAccount.error instanceof Error
                  ? addExternalAccount.error.message
                  : "Could not add wallet."
              }
            />
          ) : null}
          {activeAccount?.kind === "internal_privy" &&
          activeAccount.nextAction === "activate_deposit_wallet" ? (
            <Button
              variant="ghost"
              className="w-full"
              disabled={activateDepositWallet.isPending}
              onClick={() => activateDepositWallet.mutate()}
            >
              <Zap size={14} />
              {activateDepositWallet.isPending ? "Activating…" : "Activate deposit wallet"}
            </Button>
          ) : null}
          {activeAccount?.signingMode === "browser" ? (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => void setupTradingCredentials()}
              disabled={
                setupCreds.isPending ||
                setupCreds.isSuccess ||
                activeAccount.credentialsReady ||
                !connectedMatchesActive
              }
              title="Sign once to derive CLOB API credentials for the selected wallet"
            >
              {setupCreds.isPending ? (
                <RefreshCcw size={14} className="animate-spin" />
              ) : (
                <KeyRound size={14} />
              )}
              {setupCreds.isPending
                ? "Check wallet…"
                : activeAccount.credentialsReady || setupCreds.isSuccess
                  ? "Credentials ready"
                  : "Set up trading credentials"}
            </Button>
          ) : null}
          {setupError ? <ErrorNote message={setupError} /> : null}
          {setupCreds.error ? (
            <ErrorNote
              message={`Credential setup failed: ${
                setupCreds.error instanceof Error ? setupCreds.error.message : "unknown error"
              }`}
            />
          ) : null}
          {activateDepositWallet.error ? (
            <ErrorNote
              message={
                activateDepositWallet.error instanceof Error
                  ? activateDepositWallet.error.message
                  : "Could not activate deposit wallet."
              }
            />
          ) : null}
          {activateDepositWallet.data?.relayer.deployed ? (
            <p className="text-pos">Deposit wallet active. Add funds to unlock no-popup orders.</p>
          ) : null}
        </div>
      ) : null}

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
        disabled={!canPreview || !accountCanPreview || preview.isPending}
      >
        {preview.isPending ? "Previewing…" : "Preview order"}
      </Button>

      {!signedIn ? (
        <p className="text-xs text-muted">Sign in to preview an order.</p>
      ) : isStale ? (
        <p className="text-xs text-warn">
          Orderbook is stale — preview is held back (fail-closed).
        </p>
      ) : activeAccount && !accountCanPreview ? (
        <p className="text-xs text-warn">
          Selected wallet is not ready for order preview. Use an external wallet or activate the
          internal deposit wallet.
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
          <Row k="Signature type" v={`${preview.data.signatureType}`} />
          <Row k="Trading account" v={preview.data.tradingAccountLabel} />
          <Row k="Funder" v={preview.data.funder} mono />
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

      <Button
        className="w-full"
        onClick={() => void signAndSubmit()}
        disabled={
          !preview.data ||
          !tradingEnabled ||
          submit.isPending ||
          Boolean(submit.data) ||
          !selectedBrowserAccountReady
        }
        title={submitBlockedReason ?? "Sign and submit this order"}
      >
        {submitButtonLabel}
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

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function statusLabel(status: string, nextAction?: string | null) {
  if (status === "ready") return "ready";
  if (nextAction === "setup_credentials") return "credentials needed";
  if (nextAction === "activate_deposit_wallet") return "deposit wallet needed";
  if (nextAction === "top_up") return "top up needed";
  return status.replaceAll("_", " ");
}
