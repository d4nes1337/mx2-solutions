"use client";

/**
 * The browser-alert opt-in + per-device notification toggles. This is the ONE
 * place the OS notification permission may be requested (an explicit user
 * gesture). Shared by the Action Center drawer footer and the arm-time
 * activation sheet.
 */
import Link from "next/link";
import { Bell, Check, Send, Volume2 } from "lucide-react";
import { Button } from "@/components/ui";
import { useNotificationPrefs } from "@/lib/notification-prefs";
import { requestDesktopPermission, desktopPermission } from "@/lib/action-center/desktop";
import { playAlertSound } from "@/lib/action-center/sound";

export function NotificationControls() {
  const prefs = useNotificationPrefs();
  const perm = desktopPermission();

  const enable = () => {
    // The ONE gesture that may request OS permission and unlock audio.
    prefs.set({ browserAlerts: true });
    void requestDesktopPermission();
    playAlertSound(prefs.volume);
  };

  if (!prefs.browserAlerts) {
    return (
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-[12px] leading-snug text-muted">
          Get alerted the moment a strategy is ready to sign — a ping, a tab badge, and (when the
          tab is in the background) a desktop notification.
        </p>
        <Button size="sm" className="w-full" onClick={enable}>
          <Bell size={13} aria-hidden />
          Enable browser alerts
        </Button>
        <p className="text-[11px] text-muted">
          You can also{" "}
          <Link href="/wallet" className="text-accent hover:underline">
            connect Telegram
          </Link>{" "}
          for alerts when Arima is closed.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg">
          <Check size={13} className="text-pos" aria-hidden /> Browser alerts on
        </span>
        <button
          type="button"
          onClick={() => playAlertSound(prefs.volume)}
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
        >
          <Volume2 size={12} aria-hidden /> Play test sound
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[12px]">
        <label className="flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={prefs.sound}
            onChange={(e) => prefs.set({ sound: e.target.checked })}
          />
          Sound
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={prefs.desktop}
            onChange={(e) => prefs.set({ desktop: e.target.checked })}
          />
          Desktop {perm === "denied" ? "(blocked)" : ""}
        </label>
        <label className="col-span-2 flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={prefs.showDetails}
            onChange={(e) => prefs.set({ showDetails: e.target.checked })}
          />
          Show trade details in desktop notifications
        </label>
        <label className="col-span-2 flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={prefs.autoOpenReady}
            onChange={(e) => prefs.set({ autoOpenReady: e.target.checked })}
          />
          Open the sign popup automatically when a strategy fires
        </label>
      </div>
      <p className="text-[11px] text-muted">
        <Link href="/wallet" className="text-accent hover:underline">
          <Send size={11} className="mr-0.5 inline" aria-hidden />
          Connect Telegram
        </Link>{" "}
        for alerts when Arima is closed.
      </p>
    </div>
  );
}
