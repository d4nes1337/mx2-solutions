"use client";

/**
 * The WATCH zone's "+ Add market" bar: opens the shared market search and
 * adds the pick as a watched-market card, ready for conditions. The market
 * cap is enforced here rather than at save time, so the limit is discovered
 * before the user invests in a strategy the engine would reject.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { EXPR_LIMITS } from "@mx2/rules";
import { SheetPanel } from "@/components/ui/SheetPanel";
import { InstantMarketsRail } from "@/components/builder/InstantMarketsRail";
import { MarketSearch } from "@/components/builder/MarketSearch";
import { docMarketRefs } from "@/lib/strategies/doc";
import { useBuilderStore } from "@/lib/strategies/store";

export function AddMarketBar() {
  const [open, setOpen] = useState(false);
  const doc = useBuilderStore((s) => s.doc);
  const addWatchedMarket = useBuilderStore((s) => s.addWatchedMarket);
  const count = docMarketRefs(doc).length;
  const atCap = count >= EXPR_LIMITS.maxMarkets;

  return (
    <>
      <button
        type="button"
        data-tour="builder-add"
        disabled={atCap}
        onClick={() => setOpen(true)}
        title={
          atCap
            ? `A strategy can watch at most ${EXPR_LIMITS.maxMarkets} markets.`
            : "Add another market to watch"
        }
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-surface px-3 py-2.5 text-[13px] font-medium text-muted transition-colors hover:border-brand/50 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-muted"
      >
        <Plus size={14} aria-hidden />
        {atCap ? `Market limit reached (${EXPR_LIMITS.maxMarkets})` : "Add market to watch"}
      </button>
      <SheetPanel
        open={open}
        onClose={() => setOpen(false)}
        title="Add a market to watch"
        description={`${count} of ${EXPR_LIMITS.maxMarkets} markets used.`}
        size="lg"
      >
        <MarketSearch
          autoFocus
          onPick={(ref, meta) => {
            addWatchedMarket(ref, meta);
            setOpen(false);
          }}
          idleContent={
            <InstantMarketsRail
              onPick={(ref, meta) => {
                addWatchedMarket(ref, meta);
                setOpen(false);
              }}
            />
          }
        />
      </SheetPanel>
    </>
  );
}
