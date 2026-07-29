"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useSession } from "@/lib/auth";
import { Empty, Segmented, Spinner } from "@/components/ui";
import { OverviewTab } from "@/components/admin/OverviewTab";
import { CodesTab } from "@/components/admin/CodesTab";
import { UsersTab } from "@/components/admin/UsersTab";
import { WaitlistTab } from "@/components/admin/WaitlistTab";

type Tab = "overview" | "codes" | "users" | "waitlist";

/**
 * Owner admin panel. Visibility is cosmetic — every /api/admin/panel/* route
 * re-checks the wallet session against ADMIN_WALLET_ADDRESSES server-side.
 */
export default function AdminPage() {
  const session = useSession();
  const [tab, setTab] = useState<Tab>("overview");

  if (session.isPending) return <Spinner label="Loading…" />;
  if (!session.data?.isAdmin) {
    return (
      <Empty>
        <span className="inline-flex items-center gap-2">
          <ShieldAlert size={14} aria-hidden /> This page is for the arima team.
        </span>
      </Empty>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Admin</h1>
          <p className="mt-1 text-sm text-muted">
            Referral codes, users, and the waitlist. Every action here is audited.
          </p>
        </div>
        <Segmented<Tab>
          options={[
            { value: "overview", label: "Overview" },
            { value: "codes", label: "Codes" },
            { value: "users", label: "Users" },
            { value: "waitlist", label: "Waitlist" },
          ]}
          value={tab}
          onChange={setTab}
          size="md"
        />
      </div>
      {tab === "overview" ? <OverviewTab /> : null}
      {tab === "codes" ? <CodesTab /> : null}
      {tab === "users" ? <UsersTab /> : null}
      {tab === "waitlist" ? <WaitlistTab /> : null}
    </div>
  );
}
