"use client";

/**
 * Terminal dock — a persistent bottom bar answering "what's live right now?"
 * from any trading surface. Collapsed: one summary line (positions · open
 * orders · strategies). Expanded: tabbed panel reusing the portfolio tables.
 * Hidden on the builder canvas (it needs every pixel) and while signed out.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useSession } from "@/lib/auth";
import { useCancelOrder, useOpenOrders, usePortfolioOverview, useTradeStatus } from "@/lib/queries";
import { useStrategies } from "@/lib/smart-orders/queries";
import { ErrorNote, Segmented, Spinner, cn } from "@/components/ui";
import { PositionsTable } from "@/components/PositionsTable";
import { OpenOrdersTable } from "@/components/portfolio/OpenOrdersTable";
import { DockStrategiesList } from "./DockStrategiesList";

const STORAGE_KEY = "arima.dock.v1";

type DockTab = "positions" | "orders" | "strategies";

/** Live = anything the engine is still watching or acting on. */
const LIVE_STATUSES = new Set([
  "ACTIVE_WAITING",
  "ACTIVE_ACCUMULATING",
  "TRIGGERED_AWAITING_USER",
  "EXECUTING",
  "PAUSED",
]);

const SHOWN_PREFIXES = ["/markets", "/events", "/smart-orders", "/portfolio", "/profile"];
const HIDDEN_PREFIXES = ["/smart-orders/new"];
const HIDDEN_SUFFIXES = ["/edit"];

const dockVisible = (pathname: string): boolean =>
  SHOWN_PREFIXES.some((p) => pathname.startsWith(p)) &&
  !HIDDEN_PREFIXES.some((p) => pathname.startsWith(p)) &&
  !HIDDEN_SUFFIXES.some((s) => pathname.endsWith(s));

export function TerminalDock() {
  const pathname = usePathname();
  const session = useSession();
  const signedIn = Boolean(session.data);
  const visible = signedIn && dockVisible(pathname);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DockTab>("positions");
  const [hydrated, setHydrated] = useState(false);

  // Hydrate persisted state in an effect (SSR markup must be deterministic).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { open?: boolean; tab?: DockTab };
        if (typeof saved.open === "boolean") setOpen(saved.open);
        if (saved.tab === "positions" || saved.tab === "orders" || saved.tab === "strategies") {
          setTab(saved.tab);
        }
      }
    } catch {
      // corrupted state — defaults win
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ open, tab }));
    } catch {
      // storage full/blocked — non-critical
    }
  }, [open, tab, hydrated]);

  // Counts poll only while the dock is mounted; queries dedupe with portfolio.
  const overview = usePortfolioOverview(visible);
  const openOrders = useOpenOrders(visible);
  const strategies = useStrategies(visible);
  const tradeStatus = useTradeStatus();
  const qc = useQueryClient();
  const cancelOrder = useCancelOrder();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  if (!visible) return null;

  const positions = overview.data?.positions ?? [];
  const orders = openOrders.data?.openOrders ?? [];
  const liveStrategies = (strategies.data?.strategies ?? []).filter(
    (s) => LIVE_STATUSES.has(s.status) && s.archivedAt === null,
  );

  const handleCancel = async (clobOrderId: string) => {
    setCancellingId(clobOrderId);
    try {
      await cancelOrder.mutateAsync(clobOrderId);
      void qc.invalidateQueries({ queryKey: ["open-orders"] });
    } finally {
      setCancellingId(null);
    }
  };

  const summary = [
    `${positions.length} position${positions.length === 1 ? "" : "s"}`,
    `${orders.length} open order${orders.length === 1 ? "" : "s"}`,
    `${liveStrategies.length} strateg${liveStrategies.length === 1 ? "y" : "ies"}`,
  ].join(" · ");

  return (
    <>
      {/* Reserve the collapsed bar's height so the footer never hides under it. */}
      <div aria-hidden className={cn(open ? "h-[40vh]" : "h-9")} />
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/95 shadow-pop backdrop-blur-md">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-9 w-full items-center justify-between px-4 text-[12px] transition-colors hover:bg-surface-2/50"
        >
          <span className="tabular font-medium text-muted">{summary}</span>
          {open ? (
            <ChevronDown size={15} className="text-muted" aria-hidden />
          ) : (
            <ChevronUp size={15} className="text-muted" aria-hidden />
          )}
        </button>

        {open ? (
          <div className="h-[calc(40vh-2.25rem)] overflow-y-auto border-t border-border">
            <div className="sticky top-0 z-10 bg-bg/95 px-3 py-2 backdrop-blur-md">
              <Segmented
                options={[
                  { value: "positions", label: `Positions (${positions.length})` },
                  { value: "orders", label: `Open orders (${orders.length})` },
                  { value: "strategies", label: `Strategies (${liveStrategies.length})` },
                ]}
                value={tab}
                onChange={(v) => setTab(v as DockTab)}
              />
            </div>
            <div className="px-3 pb-3">
              {tab === "positions" ? (
                overview.isLoading ? (
                  <Spinner />
                ) : overview.error ? (
                  <ErrorNote message={(overview.error as Error).message} />
                ) : (
                  <PositionsTable positions={positions} />
                )
              ) : null}
              {tab === "orders" ? (
                openOrders.isLoading ? (
                  <Spinner />
                ) : openOrders.error ? (
                  <ErrorNote message={(openOrders.error as Error).message} />
                ) : (
                  <OpenOrdersTable
                    orders={orders}
                    {...(openOrders.data ? { setupRequired: openOrders.data.setupRequired } : {})}
                    {...(tradeStatus.data
                      ? { tradingEnabled: tradeStatus.data.tradingEnabled }
                      : {})}
                    onCancel={handleCancel}
                    cancellingId={cancellingId}
                  />
                )
              ) : null}
              {tab === "strategies" ? (
                strategies.isLoading ? (
                  <Spinner />
                ) : (
                  <DockStrategiesList rows={liveStrategies} />
                )
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
