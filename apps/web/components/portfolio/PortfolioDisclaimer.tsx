"use client";

import { useState } from "react";
import { cn } from "@/components/ui";

export function PortfolioDisclaimer({
  methodology,
  limitations,
}: {
  methodology: string;
  limitations: string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-sm border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-muted hover:text-fg"
      >
        <span>ⓘ PnL details</span>
        <span className={cn("transition-transform", open && "rotate-180")}>▾</span>
      </button>
      <div
        className={cn("border-t border-border px-3 py-2 text-xs text-muted", !open && "sr-only")}
      >
        <p className="mb-1">
          <span className="font-semibold text-fg">Methodology.</span> {methodology}
        </p>
        <p className="font-semibold text-fg">Limitations</p>
        <ul className="ml-4 list-disc space-y-0.5">
          {limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
