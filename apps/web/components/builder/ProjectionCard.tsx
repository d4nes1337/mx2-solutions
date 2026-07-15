"use client";

/**
 * Instant PnL projection panel (estimator-first, like MakerEstimator): a
 * deterministic payoff scenario for the strategy's order (or a hypothetical
 * $100 stake for alert strategies) plus a "would it have fired?" backtest
 * against real 30-day price history. Everything is labeled an estimate —
 * never a promise.
 */
import Link from "next/link";
import { useMemo } from "react";
import { Badge } from "@/components/ui";
import { AnimatedNumber } from "@/components/motion";
import { AreaChart } from "@/components/charts/AreaChart";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { computePayoff, payoffInputFromDoc } from "@/lib/smart-orders/projection";
import { backtestTokenId, simulateTriggers } from "@mx2/rules";
import { marketLabel } from "@/lib/smart-orders/doc";
import { cents, signedUsd, usd } from "@/lib/format";
import { useTokenPricesHistory } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import type { DraftEvaluation } from "@/lib/smart-orders/queries";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-muted">{label}</span>
      <span className="tabular font-medium text-fg">{children}</span>
    </div>
  );
}

const signedClass = (v: number) => (v >= 0 ? "text-pos" : "text-neg");

export function ProjectionCard({ evaluation }: { evaluation: DraftEvaluation | undefined }) {
  const doc = useBuilderStore((s) => s.doc);
  const session = useSession();

  const input = useMemo(
    () => payoffInputFromDoc(doc, evaluation?.markets ?? []),
    [doc, evaluation],
  );
  const btTokenId = backtestTokenId(doc.expr);
  const history = useTokenPricesHistory(btTokenId);

  const payoff = useMemo(() => (input ? computePayoff(input) : null), [input]);

  // The 30-day backtest is the expensive part — keyed on the strategy fields
  // it reads so drops/selection (which only change doc identity) skip it.
  const backtest = useMemo(
    () =>
      history.data && history.data.history.length > 1
        ? simulateTriggers({
            expr: doc.expr,
            holdsForMs: doc.holdsForMs,
            recurrence: doc.recurrence,
            action: doc.action,
            series: history.data.history,
          })
        : null,
    [history.data, doc.expr, doc.holdsForMs, doc.recurrence, doc.action],
  );

  if (!input || !payoff) return null;

  const outcome = input.outcome || "YES";
  const stakeLabel = input.hypothetical ? "Hypothetical stake" : "Capital committed";

  return (
    <aside
      className="space-y-2.5 rounded-xl border border-border bg-surface p-4 shadow-panel"
      data-tour="builder-projection"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-fg">Projection</h3>
        <Badge tone="neutral">estimates</Badge>
      </div>

      {/* The FOMO headline: what the stake could become. */}
      <div className="rounded-lg bg-surface-2 px-3 py-2.5">
        <div className="text-[11px] text-muted">
          {input.hypothetical ? "If $100 rode this trigger" : "If your order fills"} and {outcome}{" "}
          wins
        </div>
        <div className={`tabular text-xl font-semibold ${signedClass(payoff.payoffIfWinUsd)}`}>
          <AnimatedNumber value={payoff.payoffIfWinUsd} format={(n) => signedUsd(n)} />
        </div>
        <div className="mt-0.5 text-[11px] text-muted">
          {outcome} loses:{" "}
          <span className={`tabular font-medium ${signedClass(payoff.payoffIfLoseUsd)}`}>
            {signedUsd(payoff.payoffIfLoseUsd)}
          </span>
        </div>
      </div>

      <Row label={stakeLabel}>{usd(payoff.costUsd)}</Row>
      <Row label="Shares">{payoff.shares.toFixed(0)}</Row>
      <Row label="Breakeven price">{cents(payoff.breakevenPrice)}</Row>
      {payoff.markToMarketUsd !== null ? (
        <Row label="At the current price">
          <span className={signedClass(payoff.markToMarketUsd)}>
            {signedUsd(payoff.markToMarketUsd)}
          </span>
        </Row>
      ) : null}

      <div>
        <div className="mb-1 text-[11px] text-muted">PnL by exit price</div>
        <AreaChart
          data={payoff.curve}
          height={110}
          showAxis={false}
          fill
          baseline={0}
          color="var(--accent)"
          valueFormat={(v) => signedUsd(v)}
          timeFormat={(p) => cents(p)}
        />
      </div>

      {backtest?.supported && btTokenId ? (
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-[11px] text-muted">
            Last 30 days on {marketLabel(doc, { conditionId: "x", tokenId: btTokenId, outcome })}
          </div>
          {backtest.triggers.length > 0 ? (
            <>
              <div className="text-[12px] text-fg">
                Would have triggered{" "}
                <span className="tabular font-semibold">{backtest.triggers.length}×</span> →{" "}
                <span
                  className={`tabular font-semibold ${signedClass(backtest.hypotheticalPnlUsd)}`}
                >
                  {signedUsd(backtest.hypotheticalPnlUsd)}
                </span>{" "}
                hypothetical
              </div>
              <AreaChart
                data={history.data!.history.map((pt) => ({ t: pt.t, v: pt.p }))}
                height={130}
                showAxis={false}
                baseline={input.price}
                valueFormat={(v) => cents(v)}
                markers={backtest.triggers.map((trig) => ({
                  t: trig.t,
                  label: `trigger @ ${cents(trig.price)}`,
                }))}
              />
            </>
          ) : (
            <div className="text-[12px] text-muted">
              Wouldn&apos;t have triggered in the last 30 days — your conditions never held long
              enough.
            </div>
          )}
        </div>
      ) : null}

      <ul className="space-y-1 border-t border-border pt-2">
        {payoff.notes.map((note, i) => (
          <li key={i} className="text-[11px] leading-snug text-muted">
            {note}
          </li>
        ))}
        {backtest?.supported ? (
          <li className="text-[11px] leading-snug text-muted">
            Backtest approximates your conditions against trade-price history; books, liquidity and
            freshness rules are not simulated. Past prices don&apos;t predict future prices.
          </li>
        ) : null}
      </ul>

      {session.data && doc.action.kind === "order" ? (
        <Link
          href="/wallet"
          className="block rounded-lg bg-brand px-3 py-2 text-center text-[12px] font-semibold text-white transition-colors hover:bg-brand-strong"
        >
          Ready to arm it? Fund your wallet →
        </Link>
      ) : null}
    </aside>
  );
}
