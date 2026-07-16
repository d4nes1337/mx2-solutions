"use client";

/**
 * Toolbar above the canvas: an add-market search (markets appear as canvas
 * nodes ready for conditions to bind to) plus the interaction hint. Adding
 * conditions/logic/actions lives in the big "+" palette on the canvas itself.
 */
import { useState } from "react";
import { TrendingUp } from "lucide-react";
import { Button } from "@/components/ui";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useOutsideClick } from "@/lib/use-outside-click";
import { MarketSearch } from "./MarketSearch";

export function CanvasToolbar() {
  const addWatchedMarket = useBuilderStore((s) => s.addWatchedMarket);
  const setActiveTab = useBuilderStore((s) => s.setActiveTab);
  const [open, setOpen] = useState(false);
  const wrapRef = useOutsideClick<HTMLDivElement>(open, () => setOpen(false));

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
        <TrendingUp size={13} aria-hidden /> Add market
      </Button>
      <span className="text-[11px] text-faint">
        click a block to edit it in the panel · expand or resize it to edit in place
      </span>

      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-[340px] rounded-lg border border-border bg-surface p-2 shadow-pop">
          <MarketSearch
            autoFocus
            placeholder="Search a market to add to the canvas…"
            onPick={(ref, meta) => {
              addWatchedMarket(ref, meta);
              setActiveTab("market");
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
