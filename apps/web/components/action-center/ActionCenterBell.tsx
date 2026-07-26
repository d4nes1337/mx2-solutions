"use client";

import { Bell } from "lucide-react";
import { useSession } from "@/lib/auth";
import { useActionCenter } from "@/lib/queries";
import { useActionCenterUi } from "@/lib/action-center-store";

/**
 * Header Action Center control (brief §6.5). A bell that opens the drawer and
 * badges the count of items requiring a signature right now (9+ above nine).
 * Shows a subtle dot when there are awaiting items that aren't yet ready. Only
 * rendered for signed-in users.
 */
export function ActionCenterBell() {
  const session = useSession();
  const signedIn = Boolean(session.data);
  const query = useActionCenter(signedIn);
  const toggle = useActionCenterUi((s) => s.toggleDrawer);

  if (!signedIn) return null;

  const count = query.data?.actionableCount ?? 0;
  const awaiting = query.data?.items.length ?? 0;
  const label =
    count > 0
      ? `Action Center — ${count} ready to sign`
      : awaiting > 0
        ? "Action Center — items need attention"
        : "Action Center";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="relative rounded-md border border-border bg-surface-2 p-2 text-muted transition-colors hover:border-border-strong hover:text-fg"
      data-tour="action-center"
    >
      <Bell size={16} aria-hidden />
      {count > 0 ? (
        <span className="absolute -right-1 -top-1 grid min-w-[16px] place-items-center rounded-full bg-brand px-1 text-[10px] font-bold leading-4 text-white">
          {count > 9 ? "9+" : count}
        </span>
      ) : awaiting > 0 ? (
        <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-warn" />
      ) : null}
    </button>
  );
}
