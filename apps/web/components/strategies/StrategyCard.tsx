"use client";

/**
 * One strategy on the dashboard, compact by design: mini chart (live-edge
 * spliced), name, ONE status chip (AUTO folded in), a one-line market/live
 * caption, the hero metric, and a single primary action — everything else
 * lives in the "⋯" menu and the side panel. Works for v1 rules too — they
 * arrive normalized as definitionV2. Signing NEVER happens here: "Review &
 * sign" opens the existing TriggerConfirm flow.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Star,
} from "lucide-react";
import { Badge, Button, LiveDot, cn } from "@/components/ui";
import { Popover } from "@/components/ui/Popover";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { LiveCaption } from "@/components/charts/LiveCaption";
import { FlashOnChange } from "@/components/motion";
import { cents as centsFine, signedUsd } from "@/lib/format";
import { useDismissTrigger } from "@/lib/queries";
import {
  conditionLeavesOf,
  docFromDefinition,
  marketLabel,
  docMarketRefs,
} from "@/lib/strategies/doc";
import { layoutDoc } from "@/lib/strategies/layout";
import { spliceLive, type LiveQuote } from "@/lib/strategies/live-splice";
import { cents } from "@/lib/strategies/summaries";
import { sectionOf } from "@/lib/strategies/sections";
import { userStatus } from "@/lib/strategies/status";
import { useBuilderStore } from "@/lib/strategies/store";
import { useNow } from "@/lib/strategies/use-now";
import { RenameField } from "./RenameField";
import { timeAgo, timeLeft } from "./MetaRow";
import {
  useCreateStrategy,
  useSetStrategyTags,
  useStarStrategy,
  useStrategyControl,
  type OverviewResponse,
  type StrategyOverviewItem,
  type StrategyRow,
} from "@/lib/strategies/queries";

const BLOCKED_LABELS: Record<string, string> = {
  liquidity: "liquidity",
  depth: "book depth",
  time: "time window",
  spread: "spread",
  arming: "trailing arming",
  condition: "a condition",
  empty: "no conditions",
};

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

/** One action the card can take right now — first in the list renders as the button. */
interface ActionSpec {
  key: string;
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  primaryVariant?: "primary" | "outline";
}

export function StrategyCard({
  row,
  overview,
  sparklines,
  books,
  booksReceivedAtMs,
  onOpen,
  onReviewTrigger,
}: {
  row: StrategyRow;
  /** This strategy's overview item (proximity/actionability). */
  overview?: StrategyOverviewItem | undefined;
  /** Shared per-token sparkline map from the overview response. */
  sparklines?: OverviewResponse["sparklines"] | undefined;
  /** Shared per-token live books from the overview response (5s poll). */
  books?: OverviewResponse["books"] | undefined;
  /** Client-clock time the overview landed (query.dataUpdatedAt). */
  booksReceivedAtMs?: number | undefined;
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
  const now = useNow();
  const [menuOpen, setMenuOpen] = useState(false);
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

  // ONE status chip: AUTO folds into it instead of a second badge.
  const isAuto = def.action.kind === "order" && def.action.execution === "auto";
  const degraded = isAuto && Boolean(row.autoDegraded);
  const chipLabel = isAuto ? `AUTO · ${status.label}` : status.label;
  const chipTitle = degraded
    ? "This strategy asks for automatic execution, but the server can't deliver it — triggers will wait for your confirmation."
    : undefined;

  // Mini chart: the binding token's recent series with the trigger line drawn,
  // right edge spliced to the live book from the same overview poll.
  const chartToken =
    overview?.proximity?.bindingTokenId ??
    (def.action.kind === "order" ? def.action.market.tokenId : (markets[0]?.tokenId ?? null));
  const rawSeries: ChartPoint[] = (chartToken !== null ? (sparklines?.[chartToken] ?? []) : []).map(
    (p) => ({ t: p.t, v: p.p }),
  );
  const book = chartToken !== null ? books?.[chartToken] : undefined;
  const bookQuote: LiveQuote | null =
    book && !book.stale ? { bestBid: book.bestBid, bestAsk: book.bestAsk, dataAgeMs: 0 } : null;
  const { series, spliced } = spliceLive(rawSeries, bookQuote, Date.now());
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
    router.push(`/strategies/new?draft=${id}`);
  };

  const triggerId = overview?.actionability?.triggerId ?? null;

  // Everything the card can do, most urgent first: [0] is THE button, the
  // rest fold into the ⋯ menu. Same handlers as before — this is a re-layout.
  const actions: ActionSpec[] = [];
  if (section === "ready" && triggerId !== null && onReviewTrigger) {
    actions.push({
      key: "review",
      label: "Review & sign",
      onClick: () => onReviewTrigger(triggerId),
      primaryVariant: "primary",
    });
  }
  if (section === "missed" && triggerId !== null) {
    if (onReviewTrigger) {
      actions.push({
        key: "review-missed",
        label: "Review",
        title: "The price moved past your trigger — review the fresh preview before signing.",
        onClick: () => onReviewTrigger(triggerId),
        primaryVariant: "outline",
      });
    }
    actions.push({
      key: "rearm",
      label: dismiss.isPending || create.isPending ? "Re-arming…" : "Re-arm",
      icon: <RotateCcw size={11} aria-hidden />,
      disabled: dismiss.isPending || create.isPending,
      title: "Dismiss this trigger and arm a fresh copy of the strategy",
      onClick: () => rearm(triggerId),
    });
  }
  if (active) {
    actions.push({
      key: "pause",
      label: "Pause",
      disabled: control.isPending,
      onClick: () => control.mutate({ id: row.id, action: "pause" }),
    });
  }
  if (row.status === "PAUSED") {
    actions.push({
      key: "resume",
      label: "Resume",
      disabled: control.isPending,
      onClick: () => control.mutate({ id: row.id, action: "resume" }),
    });
  }
  if (terminal && row.version === 2) {
    actions.push({
      key: "restart",
      label: create.isPending ? "Restarting…" : "Restart",
      icon: <RotateCcw size={11} aria-hidden />,
      disabled: create.isPending,
      title: "Arm a fresh copy of this strategy",
      onClick: restart,
    });
  }
  if (row.archivedAt) {
    actions.push({
      key: "restore",
      label: "Restore",
      icon: <ArchiveRestore size={11} aria-hidden />,
      disabled: control.isPending,
      onClick: () => control.mutate({ id: row.id, action: "unarchive" }),
    });
  }
  // Triggered rows are not supersedable (store gate) — Re-arm first.
  if ((active || row.status === "PAUSED") && row.version === 2) {
    actions.push(
      onOpen
        ? {
            key: "edit",
            label: "Edit",
            icon: <Pencil size={11} aria-hidden />,
            title: "Tune the numbers in the side panel",
            onClick: () => onOpen(row.id),
          }
        : {
            key: "edit",
            label: "Edit",
            icon: <Pencil size={11} aria-hidden />,
            title: "Open the builder",
            href: `/strategies/${row.id}/edit`,
          },
    );
  }
  if (terminal && row.version === 2) {
    actions.push({
      key: "duplicate",
      label: "Duplicate",
      icon: <Copy size={11} aria-hidden />,
      title: "Open a copy in the builder to tweak before arming",
      onClick: duplicateToCanvas,
    });
  }
  if (archivable) {
    actions.push({
      key: "archive",
      label: "Archive",
      icon: <Archive size={11} aria-hidden />,
      disabled: control.isPending,
      title: "Hide from the list (reversible)",
      onClick: () => control.mutate({ id: row.id, action: "archive" }),
    });
  }
  if (active || row.status === "PAUSED") {
    actions.push({
      key: "cancel",
      label: "Cancel",
      danger: true,
      disabled: control.isPending,
      onClick: () => control.mutate({ id: row.id, action: "cancel" }),
    });
  }

  const primary = actions[0];
  const menuActions = actions.slice(1);

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
              live={spliced}
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
            {/* The title keeps its primary action (open the panel / the page);
                rename gets its own hover trigger so neither steals the click. */}
            <RenameField
              id={row.id}
              name={row.name}
              fallback={def.name || "Untitled strategy"}
              className="text-[14px] font-semibold"
              idle={(startEditing) => (
                <span className="group/title inline-flex min-w-0 items-center gap-1">
                  {onOpen ? (
                    <button
                      type="button"
                      onClick={() => onOpen(row.id)}
                      className="truncate text-left text-[14px] font-semibold text-fg transition-colors hover:text-accent"
                    >
                      {row.name || def.name || "Untitled strategy"}
                    </button>
                  ) : (
                    <Link
                      href={`/strategies/${row.id}`}
                      className="truncate text-[14px] font-semibold text-fg transition-colors hover:text-accent"
                    >
                      {row.name || def.name || "Untitled strategy"}
                    </Link>
                  )}
                  <button
                    type="button"
                    aria-label="Rename strategy"
                    title="Rename — this doesn't change the strategy's logic"
                    onClick={startEditing}
                    className="shrink-0 text-faint opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/title:opacity-100"
                  >
                    <Pencil size={11} aria-hidden />
                  </button>
                </span>
              )}
            />
            {status.live ? (
              <span {...(chipTitle ? { title: chipTitle } : {})}>
                <LiveDot
                  label={chipLabel.toUpperCase()}
                  tone={
                    degraded || status.tone === "warn"
                      ? "warn"
                      : status.tone === "neg"
                        ? "neg"
                        : "pos"
                  }
                />
              </span>
            ) : (
              <Badge
                tone={degraded ? "warn" : status.tone}
                {...(chipTitle ? { title: chipTitle } : {})}
              >
                {chipLabel}
              </Badge>
            )}
          </div>
          {/* One caption line: the market + how live its data is right now. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
            {markets[0] ? <span className="truncate">{marketLabel(doc, markets[0])}</span> : null}
            <LiveCaption
              quote={bookQuote}
              {...(booksReceivedAtMs ? { receivedAtMs: booksReceivedAtMs } : {})}
            />
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
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <HeroMetric row={row} item={overview} now={now} />
          <div className="flex items-center justify-end gap-1.5">
            {primary ? (
              primary.href ? (
                <Link href={primary.href}>
                  <Button
                    variant={primary.primaryVariant ?? "outline"}
                    size="sm"
                    {...(primary.title ? { title: primary.title } : {})}
                  >
                    {primary.icon}
                    {primary.label}
                  </Button>
                </Link>
              ) : (
                <Button
                  variant={primary.primaryVariant ?? "outline"}
                  size="sm"
                  disabled={primary.disabled ?? false}
                  {...(primary.title ? { title: primary.title } : {})}
                  onClick={primary.onClick}
                >
                  {primary.icon}
                  {primary.label}
                </Button>
              )
            ) : (
              <Link
                href={`/strategies/${row.id}`}
                className="inline-flex items-center gap-0.5 rounded-md p-1 text-[12px] font-medium text-muted transition-colors hover:text-fg"
                aria-label="Open strategy details"
              >
                Details <ChevronRight size={13} aria-hidden />
              </Link>
            )}
            <Popover
              open={menuOpen}
              onOpenChange={setMenuOpen}
              label="More strategy actions"
              panelClassName="min-w-40 p-1.5"
              trigger={
                <button
                  type="button"
                  aria-label="More actions"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                  className="rounded-md border border-border bg-surface p-1.5 text-muted transition-colors hover:border-border-strong hover:text-fg"
                >
                  <MoreHorizontal size={14} aria-hidden />
                </button>
              }
            >
              <div className="flex flex-col">
                {menuActions.map((a) =>
                  a.href ? (
                    <Link
                      key={a.key}
                      href={a.href}
                      {...(a.title ? { title: a.title } : {})}
                      onClick={() => setMenuOpen(false)}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-fg transition-colors hover:bg-surface-2"
                    >
                      {a.icon}
                      {a.label}
                    </Link>
                  ) : (
                    <button
                      key={a.key}
                      type="button"
                      disabled={a.disabled ?? false}
                      {...(a.title ? { title: a.title } : {})}
                      onClick={() => {
                        setMenuOpen(false);
                        a.onClick?.();
                      }}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium transition-colors disabled:opacity-50",
                        a.danger ? "text-neg hover:bg-neg/10" : "text-fg hover:bg-surface-2",
                      )}
                    >
                      {a.icon}
                      {a.label}
                    </button>
                  ),
                )}
                {menuActions.length > 0 ? <div className="my-1 h-px bg-border" /> : null}
                <Link
                  href={`/strategies/${row.id}`}
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-fg transition-colors hover:bg-surface-2"
                >
                  Details <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
            </Popover>
          </div>
        </div>
      </div>
    </div>
  );
}
