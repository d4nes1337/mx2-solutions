"use client";

import { Suspense } from "react";
import { StrategyDetailShell } from "@/components/smart-orders/detail/StrategyDetailShell";
import { Skeleton } from "@/components/ui";

export default function SmartOrderDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[600px] w-full rounded-xl" />}>
      <StrategyDetailShell />
    </Suspense>
  );
}
