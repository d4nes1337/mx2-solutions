"use client";

/**
 * One Smart Order on the dashboard — chart-first: a mini price chart with the
 * trigger line drawn on it, a per-section hero metric (edge / regret / dwell /
 * distance), status, plain-English summary, quick actions. Works for v1 rules
 * too — they arrive normalized as definitionV2. Signing NEVER happens here:
 * "Review & sign" opens the existing TriggerConfirm flow.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  X,
} from "lucide-react";
import { Badge, Button, LiveDot, cn } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { FlashOnChange } from "@/components/motion";
import { cents as centsFine, signedUsd } from "@/lib/format";
import { useDismissTrigger } from "@/lib/queries";
import {
  conditionLeavesOf,
  docFromDefinition,
  marketLabel,
  docMarketRefs,
} from "@/lib/smart-orders/doc";
import { layoutDoc } from "@/lib/smart-orders/layout";
import { strategySentence, humanDuration } from "@/lib/smart-orders/sentence";
import { cents } from "@/lib/smart-orders/summaries";
import { sectionOf } from "@/lib/smart-orders/sections";
import { userStatus } from "@/lib/smart-orders/status";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { useNow } from "@/lib/smart-orders/use-now";
import { QuickEditSheet } from "./QuickEditSheet";
import {
  useCreateStrategy,
  useSetStrategyTags,
  useStarStrategy,
  useStrategyControl,
  type OverviewResponse,
  type StrategyOverviewItem,
  type StrategyRow,
} from "@/lib/smart-orders/queries";

const timeAgo = (iso: string | null): string => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

const timeLeft = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5_400) return `${Math.round(s / 60)}m`;
  if (s < 129_600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
};

/** Estimated exposure: order cost, or the auto limits when armed. */
const exposure = (row: StrategyRow): string | null => {
  const a = row.definitionV2.action;
  if (a.kind !== "order") return null;
  const cost = a.price * a.size;
  if (a.execution === "auto" && row.definitionV2.limits) {
    return `up to $${row.definitionV2.limits.maxTotalNotional.toLocaleString()}`;
  }
  return `≈ $${cost.toFixed(2)}`;
};

const BLOCKED_LABELS: Record<string, string> = {
  liquidity: "liquidity",
  depth: "book depth",
  time: "time window",
  spread: "spread",
  arming: "trailing arming",
  condition: "a condition",
  empty: "no conditions",
};

/** Inline tag chips + editor: click + to add (Enter commits), × removes. */
function TagsRow({ row }: { row: StrategyRow }) {
  const setTags = useSetStrategyTags();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const tags = row.tags ?? [];

  const commit = () => {
    const tag = draft.trim().toLowerCase();
    setDraft("");
    setEditing(false);
    if (tag === "" || tags.includes(tag) || tags.length >= 10) return;
    setTags.mutate({ id: row.id, tags: [...tags, tag] });
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-accent"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => setTags.mutate({ id: row.id, tags: tags.filter((t) => t !== tag) })}
            className="text-accent/60 transition-colors hover:text-accent"
          >
            <X size={9} aria-hidden />
          </button>
        </span>
      ))}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft("");
              setEditing(false);
            }
          }}
          maxLength={24}
          placeholder="tag name…"
          aria-label="New tag"
          className="w-24 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] text-fg outline-none focus:border-brand"
        />
      ) : tags.length < 10 ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Add tag"
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-medium text-faint transition-colors hover:border-border-strong hover:text-muted"
        >
          <Plus size={9} aria-hidden /> tag
        </button>
      ) : null}
    </div>
  );
}

/** The one number that answers "what should I do with this card right now?" */
function HeroMetric({
  row,
  item,
  now,
}: {
  row: StrategyRow;
  item: StrategyOverviewItem | undefined;
  now: number;
}) {
  const section = sectionOf(row, item);

  if (section === "ready" && item?.actionability) {
    const { edge, edgeUsd, stillHolds } = item.actionability;
    // Edge is null when the book is stale — never fake confidence; the
    // TriggerConfirm preview fetches a live price before anything is signed.
    if (edge === null && !stillHolds) {
      return <div className="text-[12px] font-semibold text-warn">awaiting your signature</div>;
    }
    return (
      <div className="text-right">
        <FlashOnChange value={edge ?? 0}>
          <div className="tabular text-[15px] font-bold text-pos">
            {edge !== null && edge > 0
              ? `${centsFine(edge).replace("¢", "")}¢ better`
              : "condition holds"}
          </div>
        </FlashOnChange>
        {edgeUsd !== null && edge !== null && edge > 0 ? (
          <div className="tabular text-[11px] text-pos/80">≈ {signedUsd(edgeUsd)} on your size</div>
        ) : null}
      </div>
    );
  }

  if (section === "missed" && item?.actionability) {
    const { priceAtTrigger, priceNow, triggeredAt } = item.actionability;
    return (
      <div className="text-right">
        <div className="tabular text-[13px] font-semibold text-warn">
          {priceAtTrigger !== null ? `hit ${cents(priceAtTrigger)}` : "triggered"}
          {priceNow !== null ? ` · now ${cents(priceNow)}` : ""}
        </div>
        {triggeredAt ? <div className="text-[11px] text-faint">{timeAgo(triggeredAt)}</div> : null}
      </div>
    );
  }

  // Hold window running: a live bar beats any number.
  if (row.status === "ACTIVE_ACCUMULATING" && row.trueSince !== null) {
    const holdsForMs = row.definitionV2.holdsForMs;
    const elapsed = now - new Date(row.trueSince).getTime();
    const frac = holdsForMs > 0 ? Math.min(1, Math.max(0, elapsed / holdsForMs)) : 1;
    return (
      <div className="w-36 text-right">
        <div className="tabular text-[12px] font-semibold text-accent">
          holding {Math.round(frac * 100)}%
          {holdsForMs > 0 ? ` · ~${timeLeft(holdsForMs - elapsed)} left` : ""}
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
      </div>
    );
  }

  if (row.status === "EXECUTING") {
    return <div className="text-[12px] font-semibold text-accent">auto-executing…</div>;
  }

  const prox = item?.proximity;
  if ((section === "approaching" || section === "watching") && prox) {
    if (prox.bindingDistance !== null && prox.bindingDistance > 0) {
      return (
        <div className="text-right">
          <FlashOnChange value={prox.bindingDistance}>
            <div className="tabular text-[15px] font-bold text-fg">
              {centsFine(prox.bindingDistance)} away
            </div>
          </FlashOnChange>
          {prox.drift === "approaching" ? (
            <div className="text-[11px] font-medium text-pos">closing in</div>
          ) : prox.drift === "retreating" ? (
            <div className="text-[11px] text-faint">drifting away</div>
          ) : null}
        </div>
      );
    }
    if (prox.blockedBy.length > 0) {
      return (
        <div className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn">
          blocked by {prox.blockedBy.map((b) => BLOCKED_LABELS[b] ?? b).join(" + ")}
        </div>
      );
    }
    if (prox.leaves.some((l) => l.stale)) {
      return <div className="text-[11px] text-faint">no fresh data</div>;
    }
  }
  return null;
}

export function StrategyCard({
  row,
  overview,
  sparklines,
  onOpen,
  onReviewTrigger,
}: {
  row: StrategyRow;
  /** This strategy's overview item (proximity/actionability). */
  overview?: StrategyOverviewItem | undefined;
  /** Shared per-token sparkline map from the overview response. */
  sparklines?: OverviewResponse["sparklines"] | undefined;
  /** Open the strategy panel (falls back to the detail page link). */
  onOpen?: ((id: string) => void) | undefined;
  /** Open the TriggerConfirm flow for an awaiting trigger. */
  onReviewTrigger?: ((triggerId: string) => void) | undefined;
}) {
  const router = useRouter();
  const control = useStrategyControl();
  const create = useCreateStrategy();
  const setTags = useSetStrategyTags();
  const star = useStarStrategy();
  const dismiss = useDismissTrigger();
  const spawnDraft = useBuilderStore((s) => s.spawnDraft);
  const [quickEdit, setQuickEdit] = useState(false);
  const now = useNow();
  const def = row.definitionV2;
  const doc = docFromDefinition(def);
  const status = userStatus(row.status, {
    actionKind: def.action.kind,
    execution: def.action.kind === "order" ? def.action.execution : undefined,
  });
  const active = status.group === "monitoring";
  const markets = docMarketRefs(doc);
  const section = sectionOf(row, overview);
  /** Terminal rows can be archived (reversible soft-hide; never a delete). */
  const terminal = ["completed", "ended", "failed"].includes(status.group);
  const archivable = !row.archivedAt && terminal;
  const starred = row.starredAt !== null;

  // Mini chart: the binding token's recent series with the trigger line drawn.
  const chartToken =
    overview?.proximity?.bindingTokenId ??
    (def.action.kind === "order" ? def.action.market.tokenId : (markets[0]?.tokenId ?? null));
  const series: ChartPoint[] = (chartToken !== null ? (sparklines?.[chartToken] ?? []) : []).map(
    (p) => ({ t: p.t, v: p.p }),
  );
  const chartThreshold =
    chartToken !== null
      ? ((
          conditionLeavesOf(doc.expr).find(
            ({ condition: c }) =>
              c.kind === "price" && "market" in c && c.market.tokenId === chartToken,
          )?.condition as { threshold?: number } | undefined
        )?.threshold ?? null)
      : null;

  // Restart = duplicate-and-arm: definitions are immutable (evidence-tied), so
  // "reactivating" a cancelled/ended strategy creates a fresh row from the same
  // definition — mirroring the edit flow. Past expiries are stripped; the
  // server re-validates markets and fails cleanly if one has since resolved.
  const restart = () => {
    const expiresAtMs =
      def.expiresAtMs !== null && def.expiresAtMs > Date.now() ? def.expiresAtMs : null;
    create.mutate(
      { ...def, expiresAtMs },
      {
        onSuccess: (created) => {
          if ((row.tags ?? []).length > 0) {
            setTags.mutate({ id: created.id, tags: row.tags });
          }
        },
      },
    );
  };

  // Missed trigger → dismiss it and re-arm a fresh copy in one gesture.
  const rearm = (triggerId: string) => {
    dismiss.mutate(triggerId, { onSuccess: restart });
  };

  // Duplicate to canvas: reopen the definition as a fresh DRAFT for editing
  // before arming (tweak the price, swap the market, then Save & arm).
  const duplicateToCanvas = () => {
    const id = spawnDraft(layoutDoc(docFromDefinition(def)), { origin: "clone" });
    router.push(`/smart-orders/new?draft=${id}`);
  };

  const triggerId = overview?.actionability?.triggerId ?? null;

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface p-4 shadow-panel transition-colors hover:border-border-strong",
        onOpen ? "cursor-pointer" : undefined,
      )}
      onClick={
        onOpen
          ? (e) => {
              // Inner controls keep their own behavior; blank areas open the panel.
              if ((e.target as HTMLElement).closest("button, a, input, [role=dialog]")) return;
              onOpen(row.id);
            }
          : undefined
      }
    >
      <div className="flex flex-wrap items-start gap-3">
        {series.length >= 2 ? (
          <div className="hidden w-44 shrink-0 sm:block">
            <AreaChart
              data={series}
              height={72}
              showAxis={false}
              valueFormat={(v) => centsFine(v)}
              {...(chartThreshold !== null
                ? {
                    baselines: [{ value: chartThreshold, label: cents(chartThreshold) }],
                    includeInDomain: [chartThreshold],
                  }
                : {})}
            />
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={starred ? "Unstar strategy" : "Star strategy"}
              aria-pressed={starred}
              title={
                starred ? "Unpin from the top of its section" : "Pin to the top of its section"
              }
              disabled={star.isPending}
              onClick={() => star.mutate({ id: row.id, starred: !starred })}
              className={cn(
                "transition-colors",
                starred ? "text-warn" : "text-faint hover:text-muted",
              )}
            >
              <Star size={13} aria-hidden fill={starred ? "currentColor" : "none"} />
            </button>
            {onOpen ? (
              <button
                type="button"
                onClick={() => onOpen(row.id)}
                className="text-left text-[14px] font-semibold text-fg transition-colors hover:text-accent"
              >
                {row.name || def.name || "Smart Order"}
              </button>
            ) : (
              <Link
                href={`/smart-orders/${row.id}`}
                className="text-[14px] font-semibold text-fg transition-colors hover:text-accent"
              >
                {row.name || def.name || "Smart Order"}
              </Link>
            )}
            {status.live ? (
              <LiveDot
                label={status.label.toUpperCase()}
                tone={status.tone === "neg" ? "neg" : status.tone === "warn" ? "warn" : "pos"}
              />
            ) : (
              <Badge tone={status.tone}>{status.label}</Badge>
            )}
            {def.action.kind === "order" && def.action.execution === "auto" ? (
              row.autoDegraded ? (
                <Badge
                  tone="warn"
                  title="This strategy asks for automatic execution, but the server can't deliver it — triggers will wait for your confirmation."
                >
                  AUTO UNAVAILABLE
                </Badge>
              ) : (
                <Badge tone="brand">AUTO</Badge>
              )
            ) : null}
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{strategySentence(doc)}</p>
          <div className="tabular mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            {markets.slice(0, 2).map((m) => (
              <span key={m.tokenId} className="truncate">
                {marketLabel(doc, m)}
              </span>
            ))}
            <span>last check {timeAgo(row.lastEvaluatedAt)}</span>
            {row.triggerCount > 0 ? <span>triggered {row.triggerCount}×</span> : null}
            {exposure(row) ? <span>exposure {exposure(row)}</span> : null}
            {row.expiresAt !== null && new Date(row.expiresAt).getTime() > now ? (
              <span>expires in {timeLeft(new Date(row.expiresAt).getTime() - now)}</span>
            ) : null}
            {def.recurrence.kind === "repeat" ? (
              <span>
                repeats {row.triggerCount}/{def.recurrence.maxRepeats} ·{" "}
                {humanDuration(def.recurrence.cooldownMs)} cooldown
              </span>
            ) : null}
          </div>
          {row.errorMessage ? (
            <p className="mt-1.5 text-[12px] text-neg">{row.errorMessage}</p>
          ) : null}
          {create.error ? (
            <p className="mt-1.5 text-[12px] text-neg">
              Couldn&apos;t restart: {(create.error as Error).message} — try Duplicate to fix it in
              the builder.
            </p>
          ) : null}
          <TagsRow row={row} />
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <HeroMetric row={row} item={overview} now={now} />
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {triggerId !== null && onReviewTrigger && section === "ready" ? (
              <Button variant="primary" size="sm" onClick={() => onReviewTrigger(triggerId)}>
                Review &amp; sign
              </Button>
            ) : null}
            {triggerId !== null && section === "missed" ? (
              <>
                {onReviewTrigger ? (
                  <Button
                    variant="outline"
                    size="sm"
                    title="The price moved past your trigger — review the fresh preview before signing."
                    onClick={() => onReviewTrigger(triggerId)}
                  >
                    Sign anyway
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={dismiss.isPending || create.isPending}
                  title="Dismiss this trigger and arm a fresh copy of the strategy"
                  onClick={() => rearm(triggerId)}
                >
                  <RotateCcw size={11} aria-hidden />
                  {dismiss.isPending || create.isPending ? "Re-arming…" : "Re-arm"}
                </Button>
              </>
            ) : null}
            {active ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={control.isPending}
                onClick={() => control.mutate({ id: row.id, action: "pause" })}
              >
                Pause
              </Button>
            ) : null}
            {row.status === "PAUSED" ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={control.isPending}
                onClick={() => control.mutate({ id: row.id, action: "resume" })}
              >
                Resume
              </Button>
            ) : null}
            {/* Triggered rows are not supersedable (store gate) — Re-arm first. */}
            {(active || row.status === "PAUSED") && row.version === 2 ? (
              <Button
                variant="ghost"
                size="sm"
                title="Edit parameters here — applies as a new version (canvas still available inside)"
                onClick={() => setQuickEdit(true)}
              >
                <Pencil size={11} aria-hidden /> Edit
              </Button>
            ) : null}
            {active || row.status === "PAUSED" ? (
              <Button
                variant="danger"
                size="sm"
                disabled={control.isPending}
                onClick={() => control.mutate({ id: row.id, action: "cancel" })}
              >
                Cancel
              </Button>
            ) : null}
            {terminal && row.version === 2 ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={create.isPending}
                  title="Arm a fresh copy of this strategy"
                  onClick={restart}
                >
                  <RotateCcw size={11} aria-hidden />
                  {create.isPending ? "Restarting…" : "Restart"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="Open a copy in the builder to tweak before arming"
                  onClick={duplicateToCanvas}
                >
                  <Copy size={11} aria-hidden /> Duplicate
                </Button>
              </>
            ) : null}
            {archivable ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={control.isPending}
                title="Hide from the list (reversible)"
                onClick={() => control.mutate({ id: row.id, action: "archive" })}
              >
                <Archive size={11} aria-hidden /> Archive
              </Button>
            ) : null}
            {row.archivedAt ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={control.isPending}
                onClick={() => control.mutate({ id: row.id, action: "unarchive" })}
              >
                <ArchiveRestore size={11} aria-hidden /> Restore
              </Button>
            ) : null}
            <Link
              href={`/smart-orders/${row.id}`}
              className="inline-flex items-center gap-0.5 rounded-md p-1 text-[12px] font-medium text-muted transition-colors hover:text-fg"
              aria-label="Open strategy details"
            >
              Details <ChevronRight size={13} aria-hidden />
            </Link>
          </div>
        </div>
      </div>
      <QuickEditSheet row={row} open={quickEdit} onClose={() => setQuickEdit(false)} />
    </div>
  );
}
