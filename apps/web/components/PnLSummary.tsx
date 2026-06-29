"use client";

import type { PnlResponse } from "@/lib/types";
import { PortfolioMetrics } from "./portfolio/PortfolioMetrics";
import { PortfolioDisclaimer } from "./portfolio/PortfolioDisclaimer";

// Back-compat wrapper: metrics strip + collapsible methodology/limitations.
export function PnLSummary({ data }: { data: PnlResponse }) {
  return (
    <div className="space-y-3">
      <PortfolioMetrics summary={data.summary} />
      <PortfolioDisclaimer methodology={data.methodology} limitations={data.limitations} />
    </div>
  );
}
