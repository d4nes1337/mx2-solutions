"use client";

import { Suspense } from "react";
import { BuilderShell } from "@/components/builder/BuilderShell";
import { Skeleton } from "@/components/ui";

export default function NewSmartOrderPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[600px] w-full rounded-xl" />}>
      <BuilderShell />
    </Suspense>
  );
}
