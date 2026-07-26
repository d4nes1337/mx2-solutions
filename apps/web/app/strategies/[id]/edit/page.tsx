"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { BuilderShell } from "@/components/builder/BuilderShell";
import { Skeleton } from "@/components/ui";

export default function EditSmartOrderPage() {
  const params = useParams<{ id: string }>();
  return (
    <Suspense fallback={<Skeleton className="h-[600px] w-full rounded-xl" />}>
      <BuilderShell editOf={params.id} />
    </Suspense>
  );
}
