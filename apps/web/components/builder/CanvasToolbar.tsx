"use client";

/**
 * Toolbar above the canvas: the add-condition palette and an add-market
 * search. Added markets appear as canvas nodes (doc.watchedMarkets) ready for
 * conditions to bind to; the Market tab previews whichever one is focused.
 */
import { useState } from "react";
import { Plus, TrendingUp } from "lucide-react";
import type { ConditionV2 } from "@mx2/rules";
import { Button } from "@/components/ui";
import { UNBOUND } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { MarketSearch } from "./MarketSearch";

const CONDITION_MENU: { label: string; make: () => ConditionV2 }[] = [
  {
    label: "Price above / below",
    make: () => ({
      kind: "price",
      market: UNBOUND,
      source: "ask",
      comparator: "lte",
      threshold: 0.5,
    }),
  },
  {
    label: "Price moves by…",
    make: () => ({
      kind: "price_move",
      market: UNBOUND,
      direction: "drop",
      deltaThreshold: 0.05,
      windowMs: 600_000,
    }),
  },
  {
    label: "Spread tightness",
    make: () => ({ kind: "spread", market: UNBOUND, comparator: "lte", threshold: 0.02 }),
  },
  {
    label: "Liquidity at least",
    make: () => ({
      kind: "cumulative_notional",
      market: UNBOUND,
      source: "ask",
      priceBound: 0.5,
      minNotional: 1000,
    }),
  },
  {
    label: "Visible book levels",
    make: () => ({
      kind: "visible_levels",
      market: UNBOUND,
      source: "ask",
      priceBound: 0.5,
      minLevels: 3,
    }),
  },
  {
    label: "Time window",
    make: () => ({ kind: "time_window", startMs: null, endMs: null }),
  },
];

export function CanvasToolbar() {
  const addCondition = useBuilderStore((s) => s.addCondition);
  const addWatchedMarket = useBuilderStore((s) => s.addWatchedMarket);
  const setActiveTab = useBuilderStore((s) => s.setActiveTab);
  const [open, setOpen] = useState<"conditions" | "market" | null>(null);

  return (
    <div className="relative flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen((o) => (o === "conditions" ? null : "conditions"))}
      >
        <Plus size={13} aria-hidden /> Add condition
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((o) => (o === "market" ? null : "market"))}
      >
        <TrendingUp size={13} aria-hidden /> Add market
      </Button>
      <span className="text-[11px] text-faint">
        drag blocks to arrange · click a block to edit it in place
      </span>

      {open === "conditions" ? (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-56 space-y-0.5 rounded-lg border border-border bg-surface p-1.5 shadow-pop">
          {CONDITION_MENU.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                addCondition(item.make());
                setOpen(null);
              }}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg transition-colors hover:bg-surface-2"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {open === "market" ? (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-[340px] rounded-lg border border-border bg-surface p-2 shadow-pop">
          <MarketSearch
            autoFocus
            placeholder="Search a market to add to the canvas…"
            onPick={(ref, meta) => {
              addWatchedMarket(ref, meta);
              setActiveTab("market");
              setOpen(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
