"use client";

/**
 * Maker-loop designer: parameterize a delta-neutral two-sided quoting loop
 * for one market, see the hedge math honestly, and arm it (shadow mode —
 * sessions escalate to confirm/live only via the RFC-0003 ladder).
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { StrategyDefinition } from "@mx2/rules";
import { Badge, Button } from "@/components/ui";
import { useSession } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { useCreateStrategy } from "@/lib/smart-orders/queries";
import type { ScannerMarket } from "@/lib/farming/queries";

const money = (n: number) => `$${n.toFixed(2)}`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-muted">{label}</span>
      <span className="tabular font-medium text-fg">{children}</span>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  min,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix: string;
  min?: number;
  step?: number;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 focus-within:border-brand">
        <input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="tabular w-full bg-transparent text-[13px] text-fg outline-none"
        />
        <span className="shrink-0 text-[11px] text-faint">{suffix}</span>
      </div>
    </label>
  );
}

export function LoopDesigner({ market }: { market: ScannerMarket }) {
  const router = useRouter();
  const session = useSession();
  const create = useCreateStrategy();

  const [sizeShares, setSizeShares] = useState(Math.max(market.minSize ?? 50, 50));
  const [spreadCents, setSpreadCents] = useState(
    Math.min(2, Math.max(1, (market.maxSpreadCents ?? 3) - 1)),
  );
  const [toleranceCents, setToleranceCents] = useState(1);
  const [maxInventory, setMaxInventory] = useState(sizeShares * 2);
  const [maxCapital, setMaxCapital] = useState(Math.ceil(sizeShares * 1.2));
  const [maxDailyLoss, setMaxDailyLoss] = useState(10);

  const math = useMemo(() => {
    const mid =
      market.bestBid !== null && market.bestAsk !== null
        ? (market.bestBid + market.bestAsk) / 2
        : 0.5;
    const s = spreadCents / 100;
    const pairCost = 1 - 2 * s; // yes(mid−s) + no((1−mid)−s)
    const profitPerPair = 2 * s;
    const restingCapital = sizeShares * (mid - s) + sizeShares * (1 - mid - s);
    const qualifiesSize = market.minSize === null || sizeShares >= market.minSize;
    const qualifiesSpread = market.maxSpreadCents === null || spreadCents <= market.maxSpreadCents;
    return { mid, pairCost, profitPerPair, restingCapital, qualifiesSize, qualifiesSpread };
  }, [market, sizeShares, spreadCents]);

  const arm = () => {
    const definition: StrategyDefinition = {
      version: 2,
      name: `Rebate farm — ${market.title.slice(0, 60)}`,
      templateId: "rebate-farm",
      expr: { type: "group", id: "root", op: "and", children: [] }, // always-on gate
      holdsForMs: 0,
      maxDataAgeMs: 5_000,
      action: {
        kind: "quote_loop",
        market: {
          conditionId: market.conditionId,
          yesTokenId: market.yesTokenId!,
          noTokenId: market.noTokenId!,
          title: market.title,
          negRisk: market.negRisk,
        },
        sizeShares,
        targetSpreadCents: spreadCents,
        requoteToleranceCents: toleranceCents,
        maxInventoryShares: maxInventory,
        maxCapitalUsd: maxCapital,
        maxDailyLossUsd: maxDailyLoss,
      },
      recurrence: { kind: "once" },
      limits: null,
      expiresAtMs: null,
    };
    create.mutate(definition, {
      onSuccess: (row) => router.push(`/farming/${row.id}`),
    });
  };

  const createError =
    create.error instanceof ApiError
      ? create.error.message
      : create.error instanceof Error
        ? create.error.message
        : null;

  return (
    <div className="space-y-3 rounded-xl border border-brand/30 bg-surface p-4 shadow-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="line-clamp-1 text-[13px] font-semibold text-fg">
          Design loop — {market.title}
        </h3>
        <Badge tone="brand">shadow first</Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <NumberField
          label="Size per side"
          value={sizeShares}
          onChange={(v) => setSizeShares(Math.max(1, Math.round(v)))}
          suffix="shares"
          min={1}
        />
        <NumberField
          label="Half-spread from mid"
          value={spreadCents}
          onChange={(v) => setSpreadCents(Math.min(10, Math.max(0.5, v)))}
          suffix="¢"
          min={0.5}
          step={0.5}
        />
        <NumberField
          label="Re-quote tolerance"
          value={toleranceCents}
          onChange={(v) => setToleranceCents(Math.min(10, Math.max(0.5, v)))}
          suffix="¢"
          min={0.5}
          step={0.5}
        />
        <NumberField
          label="Max net inventory"
          value={maxInventory}
          onChange={(v) => setMaxInventory(Math.max(1, Math.round(v)))}
          suffix="shares"
          min={1}
        />
        <NumberField
          label="Max capital"
          value={maxCapital}
          onChange={(v) => setMaxCapital(Math.max(1, Math.round(v)))}
          suffix="$"
          min={1}
        />
        <NumberField
          label="Max daily loss"
          value={maxDailyLoss}
          onChange={(v) => setMaxDailyLoss(Math.max(1, Math.round(v)))}
          suffix="$"
          min={1}
        />
      </div>

      <div className="space-y-1 rounded-lg border border-border bg-surface-2/60 p-3">
        <Row label="Quotes">
          YES bid {Math.round((math.mid - spreadCents / 100) * 100)}¢ + NO bid{" "}
          {Math.round((1 - math.mid - spreadCents / 100) * 100)}¢
        </Row>
        <Row label="Pair cost (both fill)">
          {money(math.pairCost * sizeShares)} → merges back to {money(sizeShares)}
        </Row>
        <Row label="Edge per merged pair-set">+{money(math.profitPerPair * sizeShares)}</Row>
        <Row label="Capital while resting">≈{money(math.restingCapital)}</Row>
        <Row label="Rewards pool">
          {market.ratePerDayUsd > 0 ? `≈${money(market.ratePerDayUsd)}/day (shared)` : "—"}
        </Row>
        <Row label="Qualifies for rewards">
          {math.qualifiesSize && math.qualifiesSpread ? (
            <Badge tone="pos" dot>
              yes
            </Badge>
          ) : (
            <Badge tone="warn">
              {!math.qualifiesSize
                ? `size < ${market.minSize}`
                : `spread > ${market.maxSpreadCents}¢`}
            </Badge>
          )}
        </Row>
      </div>

      <p className="text-[11px] leading-snug text-muted">
        One-sided fills leave real inventory — the loop halts at your caps rather than chase. Your
        rewards share depends on competing makers; nothing here is a promised return. New loops run
        in <span className="font-semibold text-fg">shadow mode</span>: intended quotes are recorded,
        nothing is placed, no funds move.
      </p>

      {session.data ? (
        <Button className="w-full" onClick={arm} disabled={create.isPending || !market.yesTokenId}>
          {create.isPending ? "Arming…" : "Arm shadow loop"}
        </Button>
      ) : (
        <p className="text-[12px] text-muted">Sign in to arm a loop.</p>
      )}
      {createError ? <p className="text-[12px] text-neg">{createError}</p> : null}
    </div>
  );
}
