"use client";

/**
 * The big "+" on the canvas — one place to add every kind of element:
 * conditions (incl. trailing), markets, logic groups, and action presets
 * (incl. the rewards-farming loop). Sits bottom-center of the canvas; opens
 * an upward palette with outside-click/Escape close.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Plus, Repeat2, ShieldCheck, TrendingDown, TrendingUp, Zap } from "lucide-react";
import type { ConditionV2 } from "@mx2/rules";
import { cn } from "@/components/ui";
import { UNBOUND, findNode } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useFeatureFlags } from "@/lib/queries";
import { useOutsideClick } from "@/lib/use-outside-click";
import { MarketSearch } from "./MarketSearch";
import { defaultCondition } from "./editors/ConditionEditor";
import { defaultActionFor } from "./editors/ActionEditor";

const CONDITION_ITEMS: { label: string; kind: ConditionV2["kind"] }[] = [
  { label: "Price above / below", kind: "price" },
  { label: "Price moves by…", kind: "price_move" },
  { label: "Trailing peak / low", kind: "trailing" },
  { label: "Spread tightness", kind: "spread" },
  { label: "Liquidity at least", kind: "cumulative_notional" },
  { label: "Visible book levels", kind: "visible_levels" },
  { label: "Time window", kind: "time_window" },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
      {children}
    </div>
  );
}

function Item({
  onClick,
  icon,
  children,
  disabled,
  title,
}: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-fg transition-colors",
        disabled ? "cursor-not-allowed opacity-40" : "hover:bg-surface-2",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function AddPalette() {
  const router = useRouter();
  const flags = useFeatureFlags();
  const [open, setOpen] = useState(false);
  const [marketMode, setMarketMode] = useState(false);
  const wrapRef = useOutsideClick<HTMLDivElement>(open, () => {
    setOpen(false);
    setMarketMode(false);
  });

  const store = useBuilderStore;
  const makerLoop = Boolean(flags.data?.makerLoop);

  const close = () => {
    setOpen(false);
    setMarketMode(false);
  };

  const addConditionAndEdit = (kind: ConditionV2["kind"]) => {
    const s = store.getState();
    s.addCondition(defaultCondition(kind));
    s.setActiveTab("block");
    close();
  };

  const selectedConditionId = (): string | null => {
    const s = store.getState();
    const id = s.doc.selectedNodeId;
    if (!id || id === "root" || id === "action" || id.startsWith("market:")) return null;
    return findNode(s.doc.expr, id) ? id : null;
  };

  const presetProtect = () => {
    const s = store.getState();
    s.addCondition({
      kind: "trailing",
      market: UNBOUND,
      mode: "stop",
      source: "bid",
      offset: 0.08,
    });
    if (s.doc.action.kind === "alert") {
      s.setAction({
        kind: "order",
        market: UNBOUND,
        side: "SELL",
        price: 0.5,
        size: 100,
        orderType: "FAK",
        execution: "prepare",
      });
    }
    s.setActiveTab("block");
    close();
  };

  const presetDip = () => {
    const s = store.getState();
    s.addCondition({
      kind: "trailing",
      market: UNBOUND,
      mode: "entry",
      source: "ask",
      offset: 0.05,
    });
    if (s.doc.action.kind === "alert") {
      s.setAction({
        kind: "order",
        market: UNBOUND,
        side: "BUY",
        price: 0.5,
        size: 100,
        orderType: "GTD",
        expiresAfterMs: 300_000,
        execution: "prepare",
      });
    }
    s.setActiveTab("block");
    close();
  };

  const presetFarm = () => {
    if (!makerLoop) {
      router.push("/farming");
      return;
    }
    const s = store.getState();
    s.setAction(defaultActionFor("quote_loop"));
    s.select("action");
    s.setActiveTab("block");
    close();
  };

  return (
    <div
      ref={wrapRef}
      className="pointer-events-auto absolute bottom-4 left-1/2 z-10 -translate-x-1/2"
    >
      {open ? (
        <div className="absolute bottom-full left-1/2 mb-2 max-h-[min(430px,60vh)] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-2.5 shadow-pop">
          {marketMode ? (
            <div className="space-y-2">
              <SectionTitle>Add a market to the canvas</SectionTitle>
              <MarketSearch
                autoFocus
                placeholder="Search markets…"
                onPick={(ref, meta) => {
                  const s = store.getState();
                  s.addWatchedMarket(ref, meta);
                  s.setActiveTab("market");
                  close();
                }}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <SectionTitle>Conditions</SectionTitle>
                {CONDITION_ITEMS.map((item) => (
                  <Item key={item.kind} onClick={() => addConditionAndEdit(item.kind)}>
                    {item.label}
                  </Item>
                ))}
              </div>
              <div className="space-y-3">
                <div>
                  <SectionTitle>Markets &amp; logic</SectionTitle>
                  <Item
                    onClick={() => setMarketMode(true)}
                    icon={<TrendingUp size={13} className="text-accent" aria-hidden />}
                  >
                    Add market…
                  </Item>
                  <Item
                    onClick={() => {
                      const s = store.getState();
                      s.addGroup("and");
                      s.setActiveTab("block");
                      close();
                    }}
                    icon={<GitBranch size={13} className="text-accent" aria-hidden />}
                  >
                    ALL-OF group
                  </Item>
                  <Item
                    onClick={() => {
                      const s = store.getState();
                      s.addGroup("or");
                      s.setActiveTab("block");
                      close();
                    }}
                    icon={<GitBranch size={13} className="text-accent" aria-hidden />}
                  >
                    ANY-OF group
                  </Item>
                  <Item
                    onClick={() => {
                      const id = selectedConditionId();
                      if (!id) return;
                      store.getState().toggleNot(id);
                      close();
                    }}
                    disabled={selectedConditionId() === null}
                    title="Select a condition or group first"
                    icon={<Zap size={13} className="text-warn" aria-hidden />}
                  >
                    NOT — flip the selected block
                  </Item>
                </div>
                <div>
                  <SectionTitle>Action &amp; presets</SectionTitle>
                  <Item
                    onClick={() => {
                      const s = store.getState();
                      s.select("action");
                      s.setActiveTab("block");
                      close();
                    }}
                    icon={<Zap size={13} className="text-pos" aria-hidden />}
                  >
                    Edit the action…
                  </Item>
                  <Item
                    onClick={presetProtect}
                    icon={<ShieldCheck size={13} className="text-pos" aria-hidden />}
                  >
                    Protect position — trailing stop
                  </Item>
                  <Item
                    onClick={presetDip}
                    icon={<TrendingDown size={13} className="text-accent" aria-hidden />}
                  >
                    Buy the dip — trailing entry
                  </Item>
                  <Item
                    onClick={presetFarm}
                    icon={<Repeat2 size={13} className="text-accent" aria-hidden />}
                    title={
                      makerLoop
                        ? "Quote both sides near mid to earn liquidity rewards (shadow first)"
                        : "Opens the farming cockpit"
                    }
                  >
                    Farm rewards — maker loop
                  </Item>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <button
        type="button"
        aria-label={open ? "Close add menu" : "Add a block"}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        data-tour="builder-add"
        className={cn(
          "grid h-12 w-12 place-items-center rounded-full border shadow-elev transition-[transform,background-color,border-color] duration-150",
          open
            ? "rotate-45 border-border bg-surface text-fg"
            : "border-brand/40 bg-brand text-white hover:scale-105",
        )}
      >
        <Plus size={22} aria-hidden />
      </button>
    </div>
  );
}
