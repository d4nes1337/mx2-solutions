"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import type { AdminCodeItem } from "@/lib/types";

export const shortWallet = (w: string): string => `${w.slice(0, 6)}…${w.slice(-4)}`;

export const fmtUsd = (raw: string): string => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "$0";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
};

export const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString() : "—";

export function StatusBadge({ status }: { status: AdminCodeItem["status"] }) {
  const tone =
    status === "active"
      ? "pos"
      : status === "exhausted"
        ? "warn"
        : status === "disabled"
          ? "neg"
          : "neutral";
  return (
    <Badge tone={tone} dot>
      {status}
    </Badge>
  );
}

/** Dense data table shell shared by the admin tabs. */
export function AdminTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[12px]">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-faint">
            {head}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, right }: { children?: ReactNode; right?: boolean }) {
  return <th className={`px-2 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}

export function Td({
  children,
  right,
  mono,
}: {
  children: ReactNode;
  right?: boolean;
  mono?: boolean;
}) {
  return (
    <td
      className={`px-2 py-2 align-middle ${right ? "text-right" : ""} ${mono ? "font-mono" : ""}`}
    >
      {children}
    </td>
  );
}
