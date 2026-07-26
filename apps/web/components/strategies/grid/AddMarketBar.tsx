"use client";

/**
 * The WATCH zone's "+ Add market" bar: opens the shared market search and
 * adds the pick as a watched-market card, ready for conditions.
 */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { SheetShell } from "@/components/motion/primitives";
import { MarketSearch } from "@/components/builder/MarketSearch";
import { useBuilderStore } from "@/lib/strategies/store";

export function AddMarketBar() {
  const [open, setOpen] = useState(false);
  const addWatchedMarket = useBuilderStore((s) => s.addWatchedMarket);
  return (
    <>
      <button
        type="button"
        data-tour="builder-add"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-surface px-3 py-2.5 text-[13px] font-medium text-muted transition-colors hover:border-brand/50 hover:text-fg"
      >
        <Plus size={14} aria-hidden /> Add market to watch
      </button>
      <SheetShell open={open} onClose={() => setOpen(false)} label="Add a market to watch">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-[13px] font-semibold text-fg">Add a market to watch</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="text-muted transition-colors hover:text-fg"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          <MarketSearch
            autoFocus
            onPick={(ref, meta) => {
              addWatchedMarket(ref, meta);
              setOpen(false);
            }}
          />
        </div>
      </SheetShell>
    </>
  );
}
