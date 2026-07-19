"use client";

import { useEffect, type ReactNode } from "react";
import Script from "next/script";
import { getTelegramWebApp } from "@/lib/telegram";
import { useTheme } from "@/lib/theme";

/**
 * Mobile companion layout (/m/*). Loads the Telegram Mini App bridge — a
 * no-op outside Telegram — and, when inside the webview, expands the app and
 * follows Telegram's color scheme so the sheet doesn't flash-mismatch the
 * chat behind it.
 */
export default function MobileLayout({ children }: { children: ReactNode }) {
  const { setTheme } = useTheme();

  const syncTelegram = () => {
    const tg = getTelegramWebApp();
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
    } catch {
      // Older webview builds — cosmetic only.
    }
    setTheme(tg.colorScheme === "light" ? "light" : "dark");
  };

  // The script may already be cached/loaded on soft navigation.
  useEffect(() => {
    syncTelegram();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="afterInteractive"
        onLoad={syncTelegram}
      />
      {children}
    </>
  );
}
