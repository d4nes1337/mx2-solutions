"use client";

import { create } from "zustand";

/**
 * Per-device Action Center notification preferences (brief §6.5/§6.8/§6.10).
 * Persisted in localStorage — these are browser-permission-adjacent client
 * settings, not server data. `browserAlerts` is the master opt-in: it flips
 * true only after the user's explicit "Enable browser alerts" gesture (which is
 * also the ONLY moment we may request Notification permission — never on load).
 */
export interface NotificationPrefs {
  /** Master opt-in, set by the explicit enable gesture. */
  browserAlerts: boolean;
  /** Play a short ping when a new trigger becomes Ready to sign. */
  sound: boolean;
  /** 0..1. */
  volume: number;
  /** Show an OS desktop notification when the tab is hidden. */
  desktop: boolean;
  /** Include trade details in the OS notification body (default OFF, privacy). */
  showDetails: boolean;
}

const KEY = "arima.action-center.prefs.v1";

const DEFAULTS: NotificationPrefs = {
  browserAlerts: false,
  sound: true,
  volume: 0.4,
  desktop: true,
  showDetails: false,
};

const load = (): NotificationPrefs => {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
};

const persist = (prefs: NotificationPrefs): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — prefs stay in-memory for the session */
  }
};

interface NotificationPrefsStore extends NotificationPrefs {
  set: (patch: Partial<NotificationPrefs>) => void;
}

export const useNotificationPrefs = create<NotificationPrefsStore>((set, get) => ({
  ...load(),
  set: (patch) => {
    const next = { ...get(), ...patch };
    persist(next);
    set(patch);
  },
}));

/** Non-reactive snapshot for imperative host code (sound/desktop dispatch). */
export const readNotificationPrefs = (): NotificationPrefs => {
  const { browserAlerts, sound, volume, desktop, showDetails } = useNotificationPrefs.getState();
  return { browserAlerts, sound, volume, desktop, showDetails };
};
