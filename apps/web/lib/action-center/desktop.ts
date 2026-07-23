"use client";

/**
 * Desktop (OS) notifications (brief §6.10). Permission is requested ONLY from an
 * explicit user gesture (never on load) — see requestDesktopPermission. A
 * notification is shown only when the tab is hidden and permission is granted;
 * the body is privacy-safe by default (no trade details) unless the user opts
 * in. Clicking focuses/opens Arima and the matching trigger review. Service-
 * worker push while the browser is fully closed is out of scope.
 */

export const desktopSupported = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

export const desktopPermission = (): NotificationPermission | "unsupported" =>
  desktopSupported() ? Notification.permission : "unsupported";

/** MUST be called from a user gesture (the "Enable browser alerts" click). */
export const requestDesktopPermission = async (): Promise<
  NotificationPermission | "unsupported"
> => {
  if (!desktopSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
};

const PRIVACY_SAFE_BODY =
  "Your Smart Order conditions were met. Review the current market before signing.";

/**
 * Shows one OS notification for a newly-ready trigger. No-op unless the tab is
 * hidden AND permission is granted. Only the cross-tab leader should call this.
 */
export const showDesktopNotification = (opts: {
  detailLine: string | null;
  showDetails: boolean;
  onClick: () => void;
}): void => {
  if (!desktopSupported() || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return; // only when hidden
  try {
    const body = opts.showDetails && opts.detailLine ? opts.detailLine : PRIVACY_SAFE_BODY;
    const n = new Notification("Ready to sign — Arima", {
      body,
      icon: "/icon.svg",
      tag: "arima-action-center", // collapse multiples into one
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      opts.onClick();
      n.close();
    };
  } catch {
    /* ignore */
  }
};
