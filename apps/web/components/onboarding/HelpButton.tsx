"use client";

/** Header "?" — replays the mounted page's tour; hidden where no tour exists. */
import { HelpCircle } from "lucide-react";
import { startRegisteredTour, useTourAvailable } from "@/lib/onboarding";

export function HelpButton() {
  const available = useTourAvailable();
  if (!available) return null;
  return (
    <button
      type="button"
      aria-label="Replay the page tour"
      title="How does this page work?"
      onClick={startRegisteredTour}
      className="rounded-md border border-border bg-surface-2 p-2 text-muted transition-colors hover:border-border-strong hover:text-fg"
    >
      <HelpCircle size={16} aria-hidden />
    </button>
  );
}
