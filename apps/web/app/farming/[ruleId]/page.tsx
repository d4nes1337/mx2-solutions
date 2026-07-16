"use client";

/**
 * Maker-loop session monitor: the live scoreboard (inventory, capital, PnL,
 * accruals), the append-only event stream, and the halt/resume + mode
 * controls (mode escalation is blocked server-side without
 * FEATURE_MAKER_LOOP_LIVE — RFC-0003).
 */
import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, ErrorNote, Segmented, Skeleton } from "@/components/ui";
import { useFeatureFlags } from "@/lib/queries";
import { useQuoterControl, useQuoterSession } from "@/lib/farming/queries";

const money = (v: string | number) => `$${Number(v).toFixed(2)}`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/60 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className={`tabular mt-1 text-lg font-semibold leading-none ${
          tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-fg"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default function FarmingSessionPage({ params }: { params: Promise<{ ruleId: string }> }) {
  const { ruleId } = use(params);
  const flags = useFeatureFlags();
  const detail = useQuoterSession(ruleId);
  const control = useQuoterControl(ruleId);

  if (detail.isLoading) return <Skeleton className="h-72 w-full rounded-xl" />;
  if (detail.isError || !detail.data) {
    return <ErrorNote message="This quoting session isn't available (or isn't yours)." />;
  }
  const { session, recentEvents } = detail.data;
  const canGoLive = Boolean(flags.data?.makerLoopLive);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/farming" className="text-muted transition-colors hover:text-fg">
            <ArrowLeft size={16} aria-hidden />
          </Link>
          <h1 className="text-lg font-semibold tracking-tight text-fg">Maker-loop session</h1>
          <Badge
            tone={
              session.status === "quoting" ? "pos" : session.status === "halted" ? "neg" : "neutral"
            }
            dot={session.status === "quoting"}
          >
            {session.status}
            {session.haltedReason ? ` · ${session.haltedReason}` : ""}
          </Badge>
          <Badge tone={session.mode === "shadow" ? "brand" : "warn"}>{session.mode}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            options={[
              { value: "shadow", label: "Shadow" },
              { value: "confirm", label: "Confirm", disabled: !canGoLive },
              { value: "live", label: "Live", disabled: !canGoLive },
            ]}
            value={session.mode}
            onChange={(mode) => control.mutate({ action: "mode", mode })}
          />
          {session.status === "halted" ? (
            <Button size="sm" onClick={() => control.mutate({ action: "resume" })}>
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => control.mutate({ action: "halt" })}>
              Halt
            </Button>
          )}
        </div>
      </div>

      {!canGoLive ? (
        <p className="rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[12px] leading-snug text-muted">
          Confirm/live modes unlock only after the RFC-0003 ladder (shadow soak → on-chain adapter
          verification → low-value confirm trial) — the server refuses them until
          FEATURE_MAKER_LOOP_LIVE is configured.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="YES inventory" value={Number(session.inventoryYes).toFixed(0)} />
        <Stat label="NO inventory" value={Number(session.inventoryNo).toFixed(0)} />
        <Stat label="Capital committed" value={money(session.capitalCommittedUsd)} />
        <Stat
          label="Realized PnL"
          value={money(session.realizedPnlUsd)}
          tone={Number(session.realizedPnlUsd) >= 0 ? "pos" : "neg"}
        />
        <Stat label="Daily loss" value={money(session.dailyLossUsd)} />
        <Stat label="Rewards accrued" value={money(session.rewardsAccruedUsd)} tone="pos" />
      </div>

      <div className="rounded-xl border border-border bg-surface shadow-panel">
        <div className="border-b border-border px-4 py-3 text-[13px] font-semibold text-fg">
          Event stream{" "}
          <span className="font-normal text-muted">
            (append-only — in shadow mode these are intents, not orders)
          </span>
        </div>
        {recentEvents.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-muted">
            No events yet — the worker attaches armed loops within a few seconds.
          </p>
        ) : (
          <ul className="max-h-[420px] divide-y divide-border/60 overflow-y-auto">
            {recentEvents.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-2 text-[12px]">
                <span className="tabular shrink-0 text-faint">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
                <Badge
                  tone={
                    e.type === "halt"
                      ? "neg"
                      : e.type === "quote_intent" || e.type === "order_placed"
                        ? "brand"
                        : e.type.startsWith("merge")
                          ? "pos"
                          : "neutral"
                  }
                >
                  {e.type}
                </Badge>
                <code className="min-w-0 flex-1 truncate text-[11px] text-muted">
                  {JSON.stringify(e.payload)}
                </code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
