"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/auth";
import { useActionCenter } from "@/lib/queries";
import { useActionCenterUi } from "@/lib/action-center-store";
import { readNotificationPrefs } from "@/lib/notification-prefs";
import {
  isAutoOpened,
  isHandled,
  markAutoOpened,
  markHandled,
  startLeaderElection,
} from "@/lib/action-center/cross-tab";
import { setTabBadge, restoreTab } from "@/lib/action-center/tab-badge";
import { playAlertSound } from "@/lib/action-center/sound";
import { showDesktopNotification } from "@/lib/action-center/desktop";
import type { ActionCenterItem } from "@/lib/types";
import { TriggerConfirm } from "@/components/TriggerConfirm";
import { ActionCenterDrawer } from "./ActionCenterDrawer";
import { ReadyCorner } from "./ReadyCorner";

const cents = (v: string) => `${Math.round(Number(v) * 100)}c`;

/** One-line trade summary for a single ready item (desktop-notification body). */
const detailLine = (item: ActionCenterItem): string =>
  `${item.action.side === "BUY" ? "Buy" : "Sell"} ${item.action.sizeShares} ${item.market.outcome} at up to ${cents(item.action.price)} · ${item.ruleName}`;

/** True while an interruption would fight the user's current context. */
const interactionSuppressed = (): boolean => {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
    return true;
  }
  return document.querySelector('[role="dialog"]') !== null;
};

/**
 * The single global Action Center orchestrator (brief §6.2). Mounted once in
 * AppChrome (never on /m/* restricted routes). Owns the one wallet-scoped
 * actionable-trigger query and drives every side effect: tab title/favicon
 * badge (all tabs), the persistent ready-corner stack, one sound + one desktop
 * notification (leader tab only), and the ready popup — which AUTO-OPENS once
 * per newly-ready trigger (per device, deduped across tabs) unless the user is
 * typing or another dialog is up, in which case the corner card carries it.
 * It never submits anything itself.
 */
export function ActionCenterHost() {
  const session = useSession();
  const signedIn = Boolean(session.data);
  const query = useActionCenter(signedIn);
  const { open, openDrawer, reviewTriggerId, openReview, closeReview } = useActionCenterUi();

  // Per-tab "Not now" snoozes: hidden from this tab's corner, still in the bell.
  const [snoozed, setSnoozed] = useState<Set<string>>(() => new Set());
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
      setSnoozed(new Set());
    }
  }, [signedIn]);

  const data = query.data;
  useEffect(() => {
    if (!signedIn || !data) return;
    const prefs = readNotificationPrefs();

    // Every tab reflects the actionable (ready-to-sign) count in title + favicon.
    setTabBadge(data.actionableCount);

    const ready = data.items.filter((i) => i.state === "READY_TO_SIGN");

    // Auto-open the ready popup: the product's money moment. Once per trigger
    // per device (cross-tab deduped), only in a focused tab, never while the
    // user is typing or another dialog is open — those fall through to the
    // persistent corner card instead. In-app UI: independent of browserAlerts.
    if (prefs.autoOpenReady && reviewTriggerId === null && !open) {
      const candidate = ready.find((i) => !isAutoOpened(i.triggerId) && !snoozed.has(i.triggerId));
      if (candidate && document.hasFocus() && !interactionSuppressed()) {
        markAutoOpened(candidate.triggerId);
        openReview(candidate.triggerId);
      }
    }

    // Sound + desktop: LEADER tab only, once per trigger across tabs/reloads,
    // and only after the explicit browser-alerts opt-in.
    if (prefs.browserAlerts) {
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
  }, [signedIn, data, openReview, reviewTriggerId, open, snoozed]);

  if (!signedIn) return null;

  const readyItems = (data?.items ?? []).filter(
    (i) => i.state === "READY_TO_SIGN" && !snoozed.has(i.triggerId),
  );

  return (
    <>
      {/* Corner cards hide while the popup or drawer already has the user. */}
      {reviewTriggerId === null && !open ? (
        <ReadyCorner
          items={readyItems}
          onReview={(id) => {
            markAutoOpened(id);
            openReview(id);
          }}
          onLater={(id) => {
            markAutoOpened(id); // an explicit "not now" must never re-interrupt
            setSnoozed((s) => new Set(s).add(id));
          }}
          onOpenDrawer={openDrawer}
        />
      ) : null}
      <ActionCenterDrawer items={data?.items ?? []} onReview={(id) => openReview(id)} />
      {reviewTriggerId ? (
        <TriggerConfirm triggerId={reviewTriggerId} onClose={closeReview} />
      ) : null}
    </>
  );
}
