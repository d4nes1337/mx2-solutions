import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import { AppChrome } from "@/components/AppChrome";
import { THEME_INIT_SCRIPT } from "@/lib/theme-constants";

export const metadata: Metadata = {
  title: "arima — smart orders for Polymarket",
  description:
    "arima · build smart Polymarket orders visually. No code. No spreadsheets. Just logic.",
};

// viewportFit cover + safe-area padding (AppChrome) keep the mobile sign
// surface usable on notched phones and inside the Telegram webview.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Applies the persisted theme to <html> before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Providers>
          <AppChrome>{children}</AppChrome>
        </Providers>
      </body>
    </html>
  );
}
