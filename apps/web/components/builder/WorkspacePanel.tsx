"use client";

/**
 * The builder's right-hand workspace: a resizable, tabbed panel. Tabs host the
 * AI chat, simulation/backtest, and the focused market's live preview; the
 * save/arm card stays pinned below the tabs so arming is always one click
 * away. On large screens the panel is viewport-height and its tab content
 * scrolls internally (the AI tab is a real full-height chat).
 */
import { Activity, CandlestickChart, PencilRuler, SlidersHorizontal, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import type { DraftEvaluation } from "@/lib/smart-orders/queries";
import { useBuilderStore, type WorkspaceTab } from "@/lib/smart-orders/store";
import { PANEL_HEIGHT_CLASS } from "./layout-constants";
import { AiPanel } from "./AiPanel";
import { MakerEstimator } from "./MakerEstimator";
import { ProjectionCard } from "./ProjectionCard";
import { StrategySettings } from "./StrategySettings";
import { BlockTab } from "./tabs/BlockTab";
import { MarketTab } from "./tabs/MarketTab";

const TAB_META: { id: WorkspaceTab; label: string; icon: typeof Sparkles }[] = [
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "block", label: "Block", icon: PencilRuler },
  { id: "simulate", label: "Simulate", icon: Activity },
  { id: "market", label: "Market", icon: CandlestickChart },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
];

export function WorkspacePanel({
  evaluation,
  aiChatEnabled,
  aiPrompt,
  footer,
}: {
  evaluation: DraftEvaluation | undefined;
  aiChatEnabled: boolean;
  aiPrompt?: string | null;
  footer: ReactNode;
}) {
  const activeTab = useBuilderStore((s) => s.activeTab);
  const setActiveTab = useBuilderStore((s) => s.setActiveTab);

  const tabs = TAB_META.filter((t) => t.id !== "ai" || aiChatEnabled);
  const effectiveTab: WorkspaceTab = activeTab === "ai" && !aiChatEnabled ? "simulate" : activeTab;

  return (
    <aside
      className={cn("flex min-w-0 flex-col gap-2 lg:sticky lg:top-4", PANEL_HEIGHT_CLASS)}
      data-tour="builder-workspace"
    >
      <nav
        role="tablist"
        aria-label="Workspace panel"
        className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = effectiveTab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors",
                active ? "bg-surface text-fg shadow-panel" : "text-muted hover:text-fg",
              )}
            >
              <Icon size={13} aria-hidden />
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className={cn("min-h-0 flex-1", effectiveTab !== "ai" && "overflow-y-auto")}>
        {/* The chat stays mounted across tab switches so the conversation
            (and a generation in flight) survives; other tabs mount on demand. */}
        {aiChatEnabled ? (
          <div className={cn("h-full", effectiveTab !== "ai" && "hidden")}>
            <AiPanel initialPrompt={aiPrompt} />
          </div>
        ) : null}
        {effectiveTab === "simulate" ? (
          <div className="space-y-3">
            <ProjectionCard evaluation={evaluation} />
            <MakerEstimator evaluation={evaluation} />
          </div>
        ) : effectiveTab === "block" ? (
          <BlockTab />
        ) : effectiveTab === "market" ? (
          <MarketTab />
        ) : effectiveTab === "settings" ? (
          <StrategySettings />
        ) : null}
      </div>

      {footer}
    </aside>
  );
}
