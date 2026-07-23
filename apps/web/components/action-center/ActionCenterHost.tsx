"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/auth";
import { useActionCenter } from "@/lib/queries";
import { useActionCenterUi } from "@/lib/action-center-store";
import { readNotificationPrefs } from "@/lib/notification-prefs";
import { isHandled, markHandled, startLeaderElection } from "@/lib/action-center/cross-tab";
import { setTabBadge, restoreTab } from "@/lib/action-center/tab-badge";
import { playAlertSound } from "@/lib/action-center/sound";
import { showDesktopNotification } from "@/lib/action-center/desktop";
import type { ActionCenterItem } from "@/lib/types";
import { TriggerConfirm } from "@/components/TriggerConfirm";
import { ActionCenterDrawer } from "./ActionCenterDrawer";
import { ActionCenterToast, type ToastState } from "./ActionCenterToast";

const cents = (v: string) => `${Math.round(Number(v) * 100)}c`;

/** One-line trade summary for a single ready item (toast/desktop body). */
const detailLine = (item: ActionCenterItem): string =>
  `${item.action.side === "BUY" ? "Buy" : "Sell"} ${item.action.sizeShares} ${item.market.outcome} at up to ${cents(item.action.price)} · ${item.ruleName}`;

/**
 * The single global Action Center orchestrator (brief §6.2). Mounted once in
 * AppChrome (never on /m/* restricted routes). Owns the one wallet-scoped
 * actionable-trigger query and drives every side effect: tab title/favicon
 * badge (all tabs), one toast, one sound + one desktop notification (leader
 * tab only), and opening the existing TriggerConfirm fresh-review + signing
 * modal. It never submits anything itself.
 */
export function ActionCenterHost() {
  const session = useSession();
  const signedIn = Boolean(session.data);
  const query = useActionCenter(signedIn);
  const { reviewTriggerId, openReview, closeReview } = useActionCenterUi();

  const [toast, setToast] = useState<ToastState | null>(null);
  // Per-tab, in-session memory so a poll/rerender never re-toasts the same id.
  const toastedRef = useRef<Set<string>>(new Set());
  const leaderRef = useRef<{ isLeader: () => boolean; stop: () => void } | null>(null);

  // Leader election lives for the tab's lifetime.
  useEffect(() => {
    leaderRef.current = startLeaderElection();
    return () => leaderRef.current?.stop();
  }, []);

  // Restore the tab when signed out (favicon/title back to the route default).
  useEffect(() => {
    if (!signedIn) {
      restoreTab();
      setToast(null);
      toastedRef.current.clear();
    }
  }, [signedIn]);

  const data = query.data;
  useEffect(() => {
    if (!signedIn || !data) return;
    const prefs = readNotificationPrefs();

    // Every tab reflects the actionable (ready-to-sign) count in title + favicon.
    setTabBadge(data.actionableCount);

    const ready = data.items.filter((i) => i.state === "READY_TO_SIGN");

    // Toast: per-tab, once per newly-ready trigger. Alerts require the explicit
    // browser-alerts opt-in; without it, the bell + badge still update silently.
    if (prefs.browserAlerts) {
      const fresh = ready.filter((i) => !toastedRef.current.has(i.triggerId));
      if (fresh.length > 0) {
        fresh.forEach((i) => toastedRef.current.add(i.triggerId));
        const primary = fresh[0]!;
        setToast(
          fresh.length === 1
            ? {
                triggerId: primary.triggerId,
                title: "Ready to sign",
                body: detailLine(primary),
              }
            : {
                triggerId: primary.triggerId,
                title: "Ready to sign",
                body: `${fresh.length} Smart Orders are ready to sign`,
              },
        );
      }

      // Sound + desktop: LEADER tab only, once per trigger across tabs/reloads.
      const isLeader = leaderRef.current?.isLeader() ?? false;
      if (isLeader) {
        const unhandled = ready.filter((i) => !isHandled(i.triggerId));
        if (unhandled.length > 0) {
          if (prefs.sound) playAlertSound(prefs.volume);
          if (prefs.desktop) {
            const first = unhandled[0]!;
            showDesktopNotification({
              detailLine: detailLine(first),
              showDetails: prefs.showDetails,
              onClick: () => openReview(first.triggerId),
            });
          }
          unhandled.forEach((i) => markHandled(i.triggerId));
        }
      }
    }
  }, [signedIn, data, openReview]);

  if (!signedIn) return null;

  return (
    <>
      <ActionCenterToast
        toast={toast}
        onReview={(id) => {
          setToast(null);
          openReview(id);
        }}
        onDismiss={() => setToast(null)}
      />
      <ActionCenterDrawer items={data?.items ?? []} onReview={(id) => openReview(id)} />
      {reviewTriggerId ? (
        <TriggerConfirm triggerId={reviewTriggerId} onClose={closeReview} />
      ) : null}
    </>
  );
}
