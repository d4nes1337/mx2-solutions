"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, m } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, Clock, X } from "lucide-react";
import type { ActionCenterItem, ActionCenterState } from "@/lib/types";
import { useAckTrigger, useDismissTrigger } from "@/lib/queries";
import { autoFailureCopy } from "@/lib/strategies/auto-reasons";
import { useActionCenterUi } from "@/lib/action-center-store";
import { Badge, Button, cn } from "@/components/ui";
import { NotificationControls } from "./NotificationControls";
import { useReducedMotion } from "@/components/motion";

const STATE_META: Record<
  ActionCenterState,
  { label: string; tone: "brand" | "warn" | "neutral" | "pos"; cta: string }
> = {
  READY_TO_SIGN: { label: "Ready to sign", tone: "brand", cta: "Review & sign" },
  PRICE_MOVED: { label: "Price moved", tone: "warn", cta: "Review what changed" },
  WAITING_FOR_FRESH_DATA: {
    label: "Waiting for fresh data",
    tone: "neutral",
    cta: "Refresh check",
  },
  AUTO_EXECUTED: { label: "Executed automatically", tone: "pos", cta: "View details" },
};

const ageLabel = (ms: number | null): string | null => {
  if (ms === null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s old`;
  return `${Math.round(s / 60)}m old`;
};

/** matchMedia hook: desktop → right drawer, mobile → bottom sheet. */
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

function ItemCard({
  item,
  onReview,
  onRefresh,
}: {
  item: ActionCenterItem;
  onReview: (id: string) => void;
  onRefresh: () => void;
}) {
  const dismiss = useDismissTrigger();
  const ack = useAckTrigger();
  const executed = item.state === "AUTO_EXECUTED";
  const meta = STATE_META[item.state];
  const age = ageLabel(item.dataAgeMs);

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={meta.tone} dot>
          {meta.label}
        </Badge>
        <span className="text-[11px] text-faint">
          {new Date(
            executed ? (item.executed?.at ?? item.triggeredAt) : item.triggeredAt,
          ).toLocaleTimeString()}
        </span>
      </div>

      <p className="mt-2 text-[13px] font-semibold text-fg">{item.ruleName}</p>
      <p className="text-[12px] text-muted">
        {item.market.title ?? item.market.outcome} · {item.market.outcome}
      </p>
      <p className="mt-1 text-[12px] text-muted">{item.conditionSummary}</p>
      {item.autoFailed ? (
        <p className="mt-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-[12px] text-warn">
          Auto-execution failed: {autoFailureCopy(item.autoFailed.reason)} — you can sign manually.
        </p>
      ) : null}

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
        <span className="text-muted">
          {item.action.side === "BUY" ? "Buy" : "Sell"}{" "}
          <span className="tabular text-fg">{item.action.sizeShares}</span> {item.market.outcome}
        </span>
        <span className="text-muted">
          Max <span className="tabular text-fg">${item.action.maxSpendUsd}</span>
        </span>
        {item.threshold ? (
          <span className="text-muted">
            Threshold <span className="tabular text-fg">{item.threshold}</span>
          </span>
        ) : null}
        {item.actual ? (
          <span className="text-muted">
            Now <span className="tabular text-fg">{item.actual}</span>
          </span>
        ) : null}
        <span className="text-muted">
          Limit{" "}
          <span className="tabular text-fg">{Math.round(Number(item.action.price) * 100)}c</span> ·{" "}
          {item.action.orderType}
        </span>
        {age ? (
          <span className="inline-flex items-center gap-1 text-faint">
            <Clock size={11} aria-hidden /> {age}
          </span>
        ) : null}
      </div>

      {item.account ? (
        <p className="mt-1 text-[11px] text-faint">Account: {item.account.label}</p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        <Button
          size="sm"
          variant={item.state === "READY_TO_SIGN" ? "primary" : "outline"}
          onClick={() =>
            item.state === "WAITING_FOR_FRESH_DATA" ? onRefresh() : onReview(item.triggerId)
          }
        >
          {meta.cta}
        </Button>
        {/* Executed receipts are already confirmed — /dismiss would no-op and
            the card would never clear; ack marks them seen (cross-device). */}
        <button
          type="button"
          onClick={() => (executed ? ack.mutate(item.triggerId) : dismiss.mutate(item.triggerId))}
          disabled={executed ? ack.isPending : dismiss.isPending}
          className="text-[12px] text-muted hover:text-fg"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function ActionCenterDrawer({
  items,
  onReview,
}: {
  items: ActionCenterItem[];
  onReview: (id: string) => void;
}) {
  const { open, closeDrawer } = useActionCenterUi();
  const qc = useQueryClient();
  const reduced = useReducedMotion();
  const desktop = useIsDesktop();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeDrawer]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["action-center"] });

  const enter = reduced ? { opacity: 1 } : desktop ? { x: 0 } : { y: 0 };
  const from = reduced ? { opacity: 0 } : desktop ? { x: "100%" } : { y: "100%" };

  return (
    <AnimatePresence>
      {open ? (
        // Keyed motion wrapper: a plain <div> here is invisible to
        // AnimatePresence, which left the closed drawer mounted over the app
        // (same defect as SheetShell). The wrapper owns the exit fade.
        <m.div
          key="action-center"
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/50" onClick={closeDrawer} aria-hidden />
          <m.aside
            role="dialog"
            aria-modal="true"
            aria-label="Action Center"
            className={cn(
              "absolute flex flex-col border-border bg-surface shadow-panel",
              desktop
                ? "right-0 top-0 h-full w-[380px] border-l"
                : "inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t",
            )}
            initial={reduced ? false : from}
            animate={enter}
            transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34 }}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold text-fg">
                <Bell size={16} aria-hidden /> Action Center
              </h2>
              <button
                type="button"
                aria-label="Close"
                onClick={closeDrawer}
                className="rounded-md p-1 text-muted transition-colors hover:text-fg"
              >
                <X size={16} aria-hidden />
              </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {items.length === 0 ? (
                <p className="px-1 py-8 text-center text-[13px] text-muted">
                  Nothing needs your attention right now. Armed strategies will appear here the
                  moment they&apos;re ready to sign.
                </p>
              ) : (
                items.map((item) => (
                  <ItemCard
                    key={item.triggerId}
                    item={item}
                    onReview={onReview}
                    onRefresh={refresh}
                  />
                ))
              )}
            </div>

            <div className="px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">
              <NotificationControls />
            </div>
          </m.aside>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
