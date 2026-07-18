"use client";

/**
 * What the engine actually did, newest first: armed, window started, stale
 * resets, triggers, orders placed, fills. This feed is the answer to "why
 * hasn't my strategy fired?" — the exact question the audit log used to
 * swallow silently.
 */
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Play,
  RotateCcw,
  XCircle,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardHeader, Skeleton, cn } from "@/components/ui";
import type { StrategyTimeline, TimelineEvent, TimelineOrder } from "@/lib/smart-orders/queries";

interface Entry {
  key: string;
  at: number;
  icon: LucideIcon;
  tone: "pos" | "neg" | "warn" | "brand" | "muted";
  label: string;
  detail?: string;
}

const REASON_LABELS: Record<string, { label: string; tone: Entry["tone"]; icon: LucideIcon }> = {
  WINDOW_STARTED: { label: "Conditions met — hold window started", tone: "brand", icon: Play },
  WINDOW_COMPLETE: { label: "Hold window completed", tone: "pos", icon: CheckCircle2 },
  DATA_STALE: { label: "Market data went quiet — hold window reset", tone: "warn", icon: Clock },
  PRICE_FAIL: { label: "Price left the range — hold window reset", tone: "muted", icon: RotateCcw },
  RECONNECT_RESET: { label: "Feed reconnected — hold window reset", tone: "warn", icon: RotateCcw },
  RESTART_RESET: { label: "Engine restarted — hold window reset", tone: "warn", icon: RotateCcw },
  TICK_SIZE_CHANGED: { label: "Market tick size changed", tone: "warn", icon: AlertTriangle },
  MARKET_PAUSED: { label: "Market paused", tone: "warn", icon: AlertTriangle },
  MARKET_CLOSED: { label: "Market closed", tone: "muted", icon: XCircle },
  MARKET_RESOLVED: { label: "Market resolved", tone: "muted", icon: XCircle },
  EXPIRED: { label: "Strategy expired", tone: "muted", icon: Clock },
};

const fallbackReasonLabel = (reason: string): string =>
  reason
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (ch) => ch.toUpperCase());

const eventEntry = (e: TimelineEvent): Entry | null => {
  const meta = e.metadata;
  const at = new Date(e.at).getTime();
  switch (e.action) {
    case "rule.created":
      return { key: e.id, at, icon: Zap, tone: "brand", label: "Strategy armed" };
    case "rule.triggered":
      return {
        key: e.id,
        at,
        icon: Zap,
        tone: "pos",
        label: "Triggered",
        ...(typeof meta["triggerNumber"] === "number" && (meta["triggerNumber"] as number) > 1
          ? { detail: `trigger #${meta["triggerNumber"] as number}` }
          : {}),
      };
    case "rule.executed_auto":
      return { key: e.id, at, icon: CircleDollarSign, tone: "pos", label: "Auto-order submitted" };
    case "rule.execution.skipped":
      return {
        key: e.id,
        at,
        icon: AlertTriangle,
        tone: "warn",
        label: "Auto-execution skipped",
        ...(typeof meta["reason"] === "string"
          ? { detail: fallbackReasonLabel(meta["reason"] as string) }
          : {}),
      };
    case "rule.execution.failed":
      return {
        key: e.id,
        at,
        icon: XCircle,
        tone: "neg",
        label: "Auto-execution failed",
        ...(typeof meta["error"] === "string" ? { detail: meta["error"] as string } : {}),
      };
    case "rule.state_changed": {
      if (typeof meta["control"] === "string") {
        const control = meta["control"] as string;
        const labels: Record<string, string> = {
          pause: "Paused",
          resume: "Resumed",
          cancel: "Cancelled",
          disarm: "Auto placement disarmed",
          rearm: "Auto placement re-armed",
        };
        return {
          key: e.id,
          at,
          icon: Activity,
          tone: "muted",
          label: labels[control] ?? fallbackReasonLabel(control),
        };
      }
      const reason = typeof meta["reason"] === "string" ? (meta["reason"] as string) : "";
      const known = REASON_LABELS[reason];
      if (known) return { key: e.id, at, icon: known.icon, tone: known.tone, label: known.label };
      if (reason !== "") {
        return {
          key: e.id,
          at,
          icon: Activity,
          tone: "muted",
          label: fallbackReasonLabel(reason),
        };
      }
      return null;
    }
    default:
      return null;
  }
};

const orderEntries = (o: TimelineOrder): Entry[] => {
  const placedLabel = `${o.side === "BUY" ? "Buy" : "Sell"} ${o.size} @ ${Math.round(Number(o.price) * 100)}¢ placed`;
  const entries: Entry[] = [
    {
      key: `order-${o.id}`,
      at: new Date(o.createdAt).getTime(),
      icon: CircleDollarSign,
      tone: "brand",
      label: placedLabel,
    },
  ];
  return entries;
};

const timeLabel = (at: number): string => {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? hm
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
};

const TONE_TEXT: Record<Entry["tone"], string> = {
  pos: "text-pos",
  neg: "text-neg",
  warn: "text-warn",
  brand: "text-accent",
  muted: "text-muted",
};

export function ActivityTimeline({
  timeline,
  loading,
  createdAt,
}: {
  timeline: StrategyTimeline | undefined;
  loading: boolean;
  createdAt: string;
}) {
  if (loading && !timeline) {
    return (
      <Card>
        <CardHeader>Activity</CardHeader>
        <div className="space-y-2 p-4">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-5/6" />
        </div>
      </Card>
    );
  }

  const entries: Entry[] = [
    ...(timeline?.events ?? []).map(eventEntry).filter((e): e is Entry => e !== null),
    ...(timeline?.orders ?? []).flatMap(orderEntries),
  ];
  // The armed event predates the audit trail for old strategies — synthesize.
  if (!entries.some((e) => e.label === "Strategy armed")) {
    entries.push({
      key: "created",
      at: new Date(createdAt).getTime(),
      icon: Zap,
      tone: "brand",
      label: "Strategy armed",
    });
  }
  entries.sort((a, b) => b.at - a.at);

  return (
    <Card>
      <CardHeader>Activity</CardHeader>
      {entries.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-muted">
          Nothing yet — checks run every second; state changes appear here.
        </div>
      ) : (
        <ol className="max-h-[560px] overflow-y-auto">
          {entries.map((e) => {
            const Icon = e.icon;
            return (
              <li
                key={e.key}
                className="flex items-start gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0"
              >
                <Icon size={14} className={cn("mt-0.5 shrink-0", TONE_TEXT[e.tone])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] leading-snug text-fg">{e.label}</div>
                  {e.detail ? (
                    <div className="truncate text-[11px] text-faint">{e.detail}</div>
                  ) : null}
                </div>
                <span className="tabular shrink-0 text-[11px] text-faint">{timeLabel(e.at)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
