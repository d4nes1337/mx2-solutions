"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth";
import {
  useCancelOrder,
  useEquityHistory,
  useHistory,
  useOpenOrders,
  usePortfolioOverview,
  useTradeStatus,
} from "@/lib/queries";
import type { HistoryTypeFilter } from "@/lib/types";
import { Card, Empty, ErrorNote, Spinner } from "@/components/ui";
import { PositionsTable } from "@/components/PositionsTable";
import { HistoryFilters, HistoryLoadMore, HistoryTable } from "@/components/HistoryTable";
import {
  PortfolioHeader,
  PortfolioTabBar,
  useWalletOverride,
} from "@/components/portfolio/PortfolioHeader";
import { PortfolioMetrics } from "@/components/portfolio/PortfolioMetrics";
import { PortfolioDisclaimer } from "@/components/portfolio/PortfolioDisclaimer";
import { PortfolioEquityChart, useEquityWindow } from "@/components/portfolio/PortfolioEquityChart";
import { PortfolioAllocation } from "@/components/portfolio/PortfolioAllocation";
import { OpenOrdersTable } from "@/components/portfolio/OpenOrdersTable";
import { WalletsSection } from "@/components/profile/WalletsSection";
import { ShareButton } from "@/components/share/ShareButton";
import { flexModelFromPortfolio } from "@/components/share/factories";

export default function PortfolioPage() {
  const session = useSession();
  const qc = useQueryClient();
  const derivedDeposit = session.data?.depositWallet ?? undefined;
  const { proxyInput, setProxyInput, proxy } = useWalletOverride(derivedDeposit);

  const signedIn = Boolean(session.data);
  const overview = usePortfolioOverview(signedIn, proxy);
  const openOrders = useOpenOrders(signedIn);
  const tradeStatus = useTradeStatus();
  const { window, setWindow } = useEquityWindow("30d");
  const equity = useEquityHistory(signedIn, window, proxy);

  const [tab, setTab] = useState<"positions" | "orders" | "history">("positions");
  const [historyType, setHistoryType] = useState<HistoryTypeFilter>("all");
  const [historyLimit, setHistoryLimit] = useState(25);

  useEffect(() => {
    setHistoryLimit(25);
  }, [historyType]);

  const history = useHistory(signedIn, proxy, {
    limit: historyLimit,
    offset: 0,
    type: historyType,
  });

  const cancelOrder = useCancelOrder();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["portfolio-overview"] });
    void qc.invalidateQueries({ queryKey: ["equity-history"] });
    void qc.invalidateQueries({ queryKey: ["open-orders"] });
    void qc.invalidateQueries({ queryKey: ["history"] });
  };

  const refreshing =
    overview.isFetching || equity.isFetching || openOrders.isFetching || history.isFetching;

  if (session.isLoading) return <Spinner label="Checking session…" />;

  if (!signedIn) {
    return (
      <Empty>
        Connect your wallet and <strong>Sign in</strong> to view your portfolio, orders, and PnL.
      </Empty>
    );
  }

  const showDepositHint =
    !proxy &&
    overview.data !== undefined &&
    overview.data.positions.length === 0 &&
    overview.data.summary.openPositions === 0;

  const handleCancel = async (clobOrderId: string) => {
    setCancellingId(clobOrderId);
    try {
      await cancelOrder.mutateAsync(clobOrderId);
      void qc.invalidateQueries({ queryKey: ["open-orders"] });
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <PortfolioHeader
        signerAddress={session.data!.address}
        queryAddress={overview.data?.queryAddress}
        derivedDeposit={derivedDeposit}
        onRefresh={refreshAll}
        refreshing={refreshing}
        proxyInput={proxyInput}
        setProxyInput={setProxyInput}
        actions={
          overview.data ? (
            <ShareButton
              makeModel={() => flexModelFromPortfolio(overview.data!.summary)}
              label="Share PnL"
            />
          ) : undefined
        }
      />

      {showDepositHint ? (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-fg">
          No positions found — paste your Polymarket deposit wallet under <strong>⚙ Wallet</strong>{" "}
          if your portfolio lives at a different address.
        </div>
      ) : null}

      {overview.isLoading ? (
        <Spinner label="Loading portfolio…" />
      ) : overview.error ? (
        <ErrorNote message={(overview.error as Error).message} />
      ) : overview.data ? (
        <>
          <PortfolioMetrics
            summary={overview.data.summary}
            usdcBalance={openOrders.data?.balance ?? overview.data.counts.usdcBalance}
            openOrderCount={openOrders.data?.count ?? overview.data.counts.openOrders}
          />
          <PortfolioDisclaimer
            methodology={overview.data.methodology}
            limitations={overview.data.limitations}
          />
        </>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <PortfolioEquityChart
            data={equity.data}
            isLoading={equity.isLoading}
            error={equity.error as Error | null}
            window={window}
            onWindow={setWindow}
          />
        </div>
        <div className="lg:col-span-1">
          <PortfolioAllocation positions={overview.data?.positions ?? []} />
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 pt-3">
          <PortfolioTabBar
            tab={tab}
            onTab={setTab}
            positionCount={overview.data?.positions.length ?? 0}
            orderCount={openOrders.data?.count ?? overview.data?.counts.openOrders ?? 0}
          />
        </div>
        <div className="p-4">
          {tab === "positions" ? (
            overview.isLoading ? (
              <Spinner />
            ) : overview.error ? (
              <ErrorNote message={(overview.error as Error).message} />
            ) : overview.data ? (
              <PositionsTable positions={overview.data.positions} />
            ) : null
          ) : null}

          {tab === "orders" ? (
            openOrders.isLoading ? (
              <Spinner />
            ) : openOrders.error ? (
              <ErrorNote message={(openOrders.error as Error).message} />
            ) : openOrders.data ? (
              <OpenOrdersTable
                orders={openOrders.data.openOrders}
                setupRequired={openOrders.data.setupRequired}
                tradingEnabled={tradeStatus.data?.tradingEnabled}
                onCancel={handleCancel}
                cancellingId={cancellingId}
              />
            ) : null
          ) : null}

          {tab === "history" ? (
            <>
              <HistoryFilters value={historyType} onChange={setHistoryType} />
              {history.isLoading ? (
                <Spinner />
              ) : history.error ? (
                <ErrorNote message={(history.error as Error).message} />
              ) : history.data ? (
                <>
                  <HistoryTable activity={history.data.activity} />
                  <HistoryLoadMore
                    hasMore={history.data.hasMore}
                    loading={history.isFetching}
                    onLoadMore={() => setHistoryLimit((l) => l + 25)}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </Card>

      <WalletsSection signedIn={signedIn} />
    </div>
  );
}
