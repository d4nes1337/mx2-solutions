"use client";

/**
 * One-line upsell under "Missed — for now": a trigger fired and faded while
 * the user was away — exactly the moment linking Telegram/Discord (with its
 * sign-from-your-phone links) would have saved the trade. Shown only when no
 * channel is linked; dismissable per device.
 */
import Link from "next/link";
import { useState } from "react";
import { BellRing, X } from "lucide-react";
import { useNotificationChannels } from "@/lib/queries";

const DISMISS_KEY = "mx2.notifyUpsell.dismissed";

export function NotifyUpsell({ signedIn }: { signedIn: boolean }) {
  const channels = useNotificationChannels(signedIn);
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1",
  );

  if (dismissed || !channels.data || channels.data.channels.length > 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-muted">
      <BellRing size={13} aria-hidden className="shrink-0 text-accent" />
      <span className="min-w-0">
        Missed while away?{" "}
        <Link href="/wallet" className="font-medium text-accent hover:underline">
          Link Telegram or Discord
        </Link>{" "}
        — get pinged the moment a trigger fires and sign from your phone.
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
        className="ml-auto shrink-0 text-faint transition-colors hover:text-muted"
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}
