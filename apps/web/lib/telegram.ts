"use client";

/**
 * Minimal typed access to the Telegram Mini App bridge
 * (https://telegram.org/js/telegram-web-app.js, loaded by app/m/layout.tsx).
 * Presence of a non-empty initData means the page runs inside Telegram and
 * can authenticate via POST /api/auth/telegram-miniapp.
 */
export interface TelegramWebApp {
  initData: string;
  colorScheme?: "light" | "dark";
  ready(): void;
  expand(): void;
  /** Opens an external URL in the system browser (wallet deep links). */
  openLink?(url: string, options?: { try_instant_view?: boolean }): void;
}

export const getTelegramWebApp = (): TelegramWebApp | null => {
  if (typeof window === "undefined") return null;
  const tg = (window as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  return tg ?? null;
};

/** Inside Telegram with a signed identity payload? */
export const hasTelegramInitData = (): boolean => {
  const tg = getTelegramWebApp();
  return Boolean(tg && tg.initData && tg.initData.length > 0);
};
