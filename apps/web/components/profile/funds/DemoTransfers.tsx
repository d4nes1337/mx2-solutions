"use client";

/**
 * Dev-only control strip (NEXT_PUBLIC_FUNDS_DEMO=1): plays fabricated
 * transfer sequences through the demo store so every stage of the Funds
 * experience — trackers, celebration, pill lifecycle, history — can be
 * watched without moving real money. Times are compressed (2.2s per stage).
 */
import { useEffect, useRef } from "react";
import { useFundsDemo } from "@/lib/funds-demo";
import {
  bridgeWithdrawalToTransfer,
  depositToTransfer,
  walletWithdrawalToTransfer,
} from "@/lib/transfers";
import type { BridgeDepositItem, BridgeWithdrawalItem, FundsAsset } from "@/lib/types";

const STAGE_MS = 2_200;

const DEMO_ASSET: FundsAsset = {
  id: "8453:0xdemo",
  chainId: "8453",
  chainName: "Base",
  addressType: "evm",
  minCheckoutUsd: 2,
  token: { name: "USD Coin", symbol: "USDC", address: "0xdemo", decimals: 6 },
};

const demoDeposit = (state: BridgeDepositItem["state"]): BridgeDepositItem => ({
  id: "demo-dep",
  fromChainId: "8453",
  fromTokenAddress: "0xdemo",
  fromAmountBaseUnit: "50000000",
  state,
  providerStatus: state.toUpperCase(),
  txHash: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const demoBridgeWithdrawal = (state: BridgeWithdrawalItem["state"]): BridgeWithdrawalItem => ({
  id: "demo-bw",
  amountUsd: 25,
  destination: "0xdemo",
  toChainId: "8453",
  state,
  polygonTxHash: state === "requested" ? null : "0xdemo",
  bridgeTxHash: null,
  createdAt: new Date().toISOString(),
});

export function DemoTransfers() {
  const setTransfers = useFundsDemo((s) => s.setTransfers);
  const clear = useFundsDemo((s) => s.clear);
  const timers = useRef<number[]>([]);

  const stop = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };
  useEffect(() => stop, []);

  const play = (frames: (() => void)[]) => {
    stop();
    frames.forEach((frame, i) => {
      timers.current.push(window.setTimeout(frame, i * STAGE_MS));
    });
  };

  const playDeposit = () =>
    play(
      (["detected", "processing", "origin_confirmed", "submitted", "completed"] as const).map(
        (state) => () => setTransfers([depositToTransfer(demoDeposit(state), DEMO_ASSET)]),
      ),
    );

  const playBridgeWithdrawal = () =>
    play(
      (
        ["requested", "polygon_submitted", "polygon_confirmed", "bridging", "completed"] as const
      ).map(
        (state) => () => setTransfers([bridgeWithdrawalToTransfer(demoBridgeWithdrawal(state))]),
      ),
    );

  const playDirectWithdrawal = () =>
    play(
      (["requested", "submitted", "confirmed"] as const).map(
        (state) => () =>
          setTransfers([
            walletWithdrawalToTransfer({
              id: "demo-w",
              amountUsd: 10,
              destination: "0xdemo",
              state,
              transactionHash: state === "confirmed" ? "0xdemo" : null,
              createdAt: new Date().toISOString(),
            }),
          ]),
      ),
    );

  const playFailedBridge = () =>
    play(
      (["requested", "polygon_submitted", "failed_polygon"] as const).map(
        (state) => () => setTransfers([bridgeWithdrawalToTransfer(demoBridgeWithdrawal(state))]),
      ),
    );

  const btn =
    "rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted hover:text-fg";

  return (
    <div className="fixed bottom-3 left-3 z-40 flex items-center gap-1 rounded-lg border border-warn/40 bg-bg p-1.5 shadow-pop">
      <span className="px-1 text-[9px] font-semibold uppercase tracking-wide text-warn">demo</span>
      <button type="button" className={btn} onClick={playDeposit}>
        Deposit
      </button>
      <button type="button" className={btn} onClick={playBridgeWithdrawal}>
        Bridge out
      </button>
      <button type="button" className={btn} onClick={playDirectWithdrawal}>
        Direct out
      </button>
      <button type="button" className={btn} onClick={playFailedBridge}>
        Fail
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => {
          stop();
          clear();
        }}
      >
        Clear
      </button>
    </div>
  );
}
