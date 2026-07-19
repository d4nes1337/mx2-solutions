/**
 * The one normalized model for money movement — deposits (bridge), the
 * USDC.e→pUSD conversion, direct withdrawals, and two-leg bridge withdrawals
 * all map onto `ActiveTransfer`: a small step machine with a current step and
 * a human stage label. The Funds sheet tracker, the History tab, and the
 * global pending pill all render from this shape, so a backend state change
 * moves every surface at once.
 *
 * Pure module: no hooks, no fetching — unit-testable state mapping only.
 */
import { formatUnits } from "viem";
import type {
  BridgeDepositItem,
  BridgeWithdrawalItem,
  FundsAsset,
  WalletWithdrawalItem,
} from "./types";

export type TransferKind = "deposit" | "conversion" | "withdrawal" | "bridge_withdrawal";
export type TransferStatus = "pending" | "success" | "failed";

export interface TransferStep {
  id: string;
  label: string;
}

export interface ActiveTransfer {
  /** Stable across polls: "d-…" | "conversion" | "w-…" | "bw-…". */
  id: string;
  kind: TransferKind;
  direction: "in" | "out";
  /** "+5.00 USDC" | "−$25.00" | "Deposit" when the amount is unknown. */
  amountLabel: string;
  chainId: string | null;
  chainName: string | null;
  /** Raw backend state, for tone lookups and debugging. */
  state: string;
  status: TransferStatus;
  steps: TransferStep[];
  /** Index of the step in progress; on success/failure the last reached one. */
  currentStep: number;
  /** Short live description, e.g. "confirming on Base". */
  stageLabel: string;
  txUrl: string | null;
  /** Failure guidance: funds-safe retry vs contact-support. */
  failureTone: "recoverable" | "support" | null;
  createdAt: number;
  updatedAt: number;
}

// ── Shared label/tone tables (moved out of FundsSheet) ───────────────────────

export const CHAIN_NAMES: Record<string, string> = {
  "1": "Ethereum",
  "10": "Optimism",
  "56": "BNB Chain",
  "137": "Polygon",
  "8453": "Base",
  "42161": "Arbitrum",
};

export const STATE_TONE: Record<string, string> = {
  requested: "text-muted",
  submitted: "text-accent",
  confirmed: "text-pos",
  failed: "text-neg",
  // Bridge deposit states
  detected: "text-accent",
  processing: "text-accent",
  origin_confirmed: "text-accent",
  completed: "text-pos",
};

export const DEPOSIT_STATE_LABEL: Record<string, string> = {
  detected: "detected",
  processing: "processing",
  origin_confirmed: "confirmed at source",
  submitted: "arriving",
  completed: "completed",
  failed: "failed",
};

export const BRIDGE_WITHDRAWAL_STATE_LABEL: Record<string, string> = {
  requested: "starting",
  address_created: "starting",
  polygon_submitted: "leaving Polygon",
  polygon_confirmed: "left Polygon",
  bridging: "bridging",
  completed: "completed",
  failed_address: "failed (funds safe)",
  failed_polygon: "failed (funds safe)",
  failed_bridge: "needs support",
};

export const DEPOSIT_TERMINAL_STATES = new Set(["completed", "failed"]);
export const WALLET_WITHDRAWAL_TERMINAL_STATES = new Set(["confirmed", "failed"]);
export const BRIDGE_WITHDRAWAL_TERMINAL_STATES = new Set([
  "completed",
  "failed_address",
  "failed_polygon",
  "failed_bridge",
]);

export const isTerminal = (t: ActiveTransfer): boolean => t.status !== "pending";

const chainName = (chainId: string | null): string =>
  (chainId ? CHAIN_NAMES[chainId] : undefined) ?? (chainId ? `chain ${chainId}` : "source chain");

const polygonscanTx = (hash: string | null): string | null =>
  hash ? `https://polygonscan.com/tx/${hash}` : null;

// ── Deposit: Detected → Confirming on {chain} → Arriving → Complete ──────────

const DEPOSIT_STEP_FOR_STATE: Record<BridgeDepositItem["state"], number> = {
  detected: 0,
  processing: 1,
  origin_confirmed: 2,
  submitted: 2,
  completed: 3,
  failed: 1,
};

export function depositToTransfer(d: BridgeDepositItem, asset: FundsAsset | null): ActiveTransfer {
  const from = asset?.chainName ?? chainName(d.fromChainId);
  const steps: TransferStep[] = [
    { id: "detected", label: "Detected" },
    { id: "confirming", label: `Confirming on ${from}` },
    { id: "arriving", label: "Arriving on Polygon" },
    { id: "done", label: "Complete" },
  ];
  let amountLabel = "Deposit";
  if (asset && d.fromAmountBaseUnit !== "") {
    try {
      const amount = Number(formatUnits(BigInt(d.fromAmountBaseUnit), asset.token.decimals));
      amountLabel = `+${amount.toFixed(2)} ${asset.token.symbol}`;
    } catch {
      // Malformed base units from the provider: keep the generic label.
    }
  }
  const status: TransferStatus =
    d.state === "completed" ? "success" : d.state === "failed" ? "failed" : "pending";
  const stageLabel =
    d.state === "detected"
      ? "deposit detected"
      : d.state === "processing"
        ? `confirming on ${from}`
        : d.state === "origin_confirmed" || d.state === "submitted"
          ? "arriving on Polygon"
          : d.state === "completed"
            ? "completed"
            : "failed";
  return {
    id: `d-${d.id}`,
    kind: "deposit",
    direction: "in",
    amountLabel,
    chainId: d.fromChainId || null,
    chainName: from,
    state: d.state,
    status,
    steps,
    currentStep: DEPOSIT_STEP_FOR_STATE[d.state] ?? 1,
    stageLabel,
    txUrl: null, // origin-chain hash; explorer varies per chain
    failureTone: d.state === "failed" ? "support" : null,
    createdAt: new Date(d.createdAt).getTime(),
    updatedAt: new Date(d.updatedAt).getTime(),
  };
}

// ── Conversion: USDC.e arrived, Polymarket converts it to pUSD ───────────────

export function conversionToTransfer(
  unconvertedUsd: number,
  opts?: { startedAt?: number; completedAt?: number },
): ActiveTransfer {
  const done = opts?.completedAt !== undefined;
  const now = Date.now();
  return {
    id: "conversion",
    kind: "conversion",
    direction: "in",
    amountLabel: `+$${unconvertedUsd.toFixed(2)}`,
    chainId: "137",
    chainName: "Polygon",
    state: done ? "completed" : "converting",
    status: done ? "success" : "pending",
    steps: [
      { id: "arrived", label: "Arrived" },
      { id: "converting", label: "Converting to pUSD" },
      { id: "done", label: "Complete" },
    ],
    currentStep: done ? 2 : 1,
    stageLabel: done ? "converted to pUSD" : "converting to pUSD",
    txUrl: null,
    failureTone: null,
    createdAt: opts?.startedAt ?? now,
    updatedAt: opts?.completedAt ?? now,
  };
}

// ── Direct withdrawal: Submitted → Confirming on Polygon → Complete ──────────

const WALLET_WITHDRAWAL_STEP_FOR_STATE: Record<WalletWithdrawalItem["state"], number> = {
  requested: 0,
  submitted: 1,
  confirmed: 2,
  failed: 1,
};

export function walletWithdrawalToTransfer(w: WalletWithdrawalItem): ActiveTransfer {
  const status: TransferStatus =
    w.state === "confirmed" ? "success" : w.state === "failed" ? "failed" : "pending";
  const at = new Date(w.createdAt).getTime();
  return {
    id: `w-${w.id}`,
    kind: "withdrawal",
    direction: "out",
    amountLabel: `−$${w.amountUsd.toFixed(2)}`,
    chainId: "137",
    chainName: "Polygon",
    state: w.state,
    status,
    steps: [
      { id: "submitted", label: "Submitted" },
      { id: "confirming", label: "Confirming on Polygon" },
      { id: "done", label: "Complete" },
    ],
    currentStep: WALLET_WITHDRAWAL_STEP_FOR_STATE[w.state] ?? 0,
    stageLabel:
      w.state === "requested"
        ? "submitting"
        : w.state === "submitted"
          ? "confirming on Polygon"
          : w.state === "confirmed"
            ? "completed"
            : "failed",
    txUrl: polygonscanTx(w.transactionHash),
    failureTone: w.state === "failed" ? "recoverable" : null,
    createdAt: at,
    updatedAt: at,
  };
}

// ── Bridge withdrawal: Submitted → Polygon leg → Bridging → Complete ─────────

const BRIDGE_WITHDRAWAL_STEP_FOR_STATE: Record<BridgeWithdrawalItem["state"], number> = {
  requested: 0,
  address_created: 0,
  polygon_submitted: 1,
  polygon_confirmed: 2,
  bridging: 2,
  completed: 3,
  failed_address: 0,
  failed_polygon: 1,
  failed_bridge: 2,
};

export function bridgeWithdrawalToTransfer(w: BridgeWithdrawalItem): ActiveTransfer {
  const dest = chainName(w.toChainId);
  const failed = w.state.startsWith("failed");
  const status: TransferStatus =
    w.state === "completed" ? "success" : failed ? "failed" : "pending";
  const at = new Date(w.createdAt).getTime();
  return {
    id: `bw-${w.id}`,
    kind: "bridge_withdrawal",
    direction: "out",
    amountLabel: `−$${w.amountUsd.toFixed(2)}`,
    chainId: w.toChainId,
    chainName: dest,
    state: w.state,
    status,
    steps: [
      { id: "submitted", label: "Submitted" },
      { id: "polygon", label: "Confirming on Polygon" },
      { id: "bridging", label: `Bridging to ${dest}` },
      { id: "done", label: "Complete" },
    ],
    currentStep: BRIDGE_WITHDRAWAL_STEP_FOR_STATE[w.state] ?? 0,
    stageLabel:
      w.state === "requested" || w.state === "address_created"
        ? "starting"
        : w.state === "polygon_submitted"
          ? "confirming on Polygon"
          : w.state === "polygon_confirmed" || w.state === "bridging"
            ? `bridging to ${dest}`
            : w.state === "completed"
              ? "completed"
              : w.state === "failed_bridge"
                ? "needs support"
                : "failed (funds safe)",
    txUrl: polygonscanTx(w.polygonTxHash),
    failureTone: failed ? (w.state === "failed_bridge" ? "support" : "recoverable") : null,
    createdAt: at,
    updatedAt: at,
  };
}
