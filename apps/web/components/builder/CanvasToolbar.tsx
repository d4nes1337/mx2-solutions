"use client";

/**
 * Toolbar above the canvas: an add-market search (markets appear as canvas
 * nodes ready for conditions to bind to), a clear-canvas action, and the
 * interaction hint. Adding conditions/logic/actions lives in the big "+"
 * palette on the canvas itself.
 */
import { useEffect, useState } from "react";
import { Eraser, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui";
import { docHasContent } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useOutsideClick } from "@/lib/use-outside-click";
import { MarketSearch } from "./MarketSearch";

export function CanvasToolbar() {
  const addWatchedMarket = useBuilderStore((s) => s.addWatchedMarket);
  const setActiveTab = useBuilderStore((s) => s.setActiveTab);
  const clearCanvas = useBuilderStore((s) => s.clearCanvas);
  const canClear = useBuilderStore((s) => docHasContent(s.doc) || s.aiMessages.length > 0);
  const [open, setOpen] = useState(false);
  const wrapRef = useOutsideClick<HTMLDivElement>(open, () => setOpen(false));

  // Two-click confirm for Clear — armed state disarms itself after 3s.
  const [armedClear, setArmedClear] = useState(false);
  useEffect(() => {
    if (!armedClear) return;
    const t = setTimeout(() => setArmedClear(false), 3_000);
    return () => clearTimeout(t);
  }, [armedClear]);

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
        <TrendingUp size={13} aria-hidden /> Add market
      </Button>
      {canClear ? (
        <Button
          size="sm"
          variant={armedClear ? "danger" : "ghost"}
          onClick={() => {
            if (!armedClear) {
              setArmedClear(true);
              return;
            }
            clearCanvas();
            setArmedClear(false);
          }}
        >
          <Eraser size={13} aria-hidden />
          {armedClear ? "Wipe canvas + AI chat?" : "Clear"}
        </Button>
      ) : null}
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
