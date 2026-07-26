"use client";

/**
 * Homepage hero, centered and identity-first: who arima is in one line, one
 * big clean composer, and — directly below — the live prompt→strategy
 * preview where the auto-typing demo plays (the demo NEVER types inside the
 * user's own input). Persona-tested: the preview panel is the explainer
 * ("it demos the compiler, not the vibes"); taglines are supporting cast.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Hammer, Search } from "lucide-react";
import { LiveDot } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";
import { useFeatureFlags } from "@/lib/queries";
import { DEMO_SCENARIOS } from "@/lib/home/demo-scenarios";
import { useDemoPlayer } from "@/lib/home/use-demo-player";
import { useScenarioBinding } from "@/lib/home/use-scenario-binding";
import { Chip } from "./ShowcaseCard";
import { DemoTyper } from "./DemoTyper";
import { HeroComposer } from "./HeroComposer";
import { StrategyPreviewPanel } from "./StrategyPreviewPanel";

/** Demo resumes this long after the user's last composer touch. */
const IDLE_RESUME_MS = 8_000;

/** Static, decorative preview of what a strategy looks like (aiChat-off only). */
function SmartOrderPreview() {
  return (
    <div className="glass rounded-xl p-5 shadow-elev">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Strategy · Re-entry
        </span>
        <LiveDot label="WATCHING" />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-1.5 leading-relaxed">
        <Chip>If</Chip>
        <Chip tone="brand">YES price</Chip>
        <Chip>drops below 58¢</Chip>
        <Chip>for 5 minutes</Chip>
        <Chip>and</Chip>
        <Chip tone="brand">liquidity</Chip>
        <Chip>is at least $2,000</Chip>
        <span className="mx-1 text-muted">→</span>
        <Chip tone="pos">Buy YES at 57¢</Chip>
      </div>
      <div className="mt-4 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
        <span className="text-[12px] text-muted">Would trigger now?</span>
        <span className="text-[12px] font-medium text-warn">Not yet — price at 61¢</span>
      </div>
    </div>
  );
}

function MarketSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      className="mx-auto flex max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-panel focus-within:border-brand"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(q.trim() ? `/markets?q=${encodeURIComponent(q.trim())}` : "/markets");
      }}
    >
      <Search size={15} className="shrink-0 text-faint" aria-hidden />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search Polymarket markets…"
        className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint"
        aria-label="Search markets"
      />
    </form>
  );
}

export function Hero() {
  const flags = useFeatureFlags();
  // Treat the flags-loading state as AI-on (the beta default) so the FIRST
  // paint already matches the resolved value — no post-hydration message swap
  // or layout shift (brief §8.1.2). Only a definitive aiChat=false degrades to
  // the manual-builder hero; that path is not the private-beta configuration.
  const aiOn = flags.data?.aiChat !== false;
  const reduced = useReducedMotion();

  // Hovering the preview or touching the composer pauses the demo; it
  // resumes IDLE_RESUME_MS after the last composer interaction.
  const [hovered, setHovered] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteInteraction = useCallback(() => {
    setInteracting(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setInteracting(false), IDLE_RESUME_MS);
  }, []);
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  // Single owner of the demo state: preview typer bubble, chips, chart markers
  // and dots all derive from this one player — sync is structural.
  const demo = useDemoPlayer(DEMO_SCENARIOS, {
    paused: !aiOn || hovered || interacting,
    reduced,
  });
  const idx = demo.state.idx % DEMO_SCENARIOS.length;
  const active = DEMO_SCENARIOS[idx]!;
  const next = DEMO_SCENARIOS[(idx + 1) % DEMO_SCENARIOS.length]!;
  const binding = useScenarioBinding(active, aiOn);
  useScenarioBinding(next, aiOn); // prefetch — the next scenario lands bound

  return (
    <section className="space-y-8 py-6 lg:py-10">
      {/* ── Identity-first: what arima is, in two seconds ── */}
      <div className="mx-auto max-w-2xl space-y-4 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-mark-gradient.webp"
          alt=""
          aria-hidden
          className="pointer-events-none mx-auto w-16 select-none"
        />
        <h1 className="text-hero font-bold tracking-tight text-fg sm:text-hero-lg">
          If this, <span className="text-accent">then trade.</span>
        </h1>
        <p className="text-[15px] leading-relaxed text-muted">
          arima — the conditional strategies engine for Polymarket.
        </p>
        <p className="text-[13px] leading-relaxed text-muted">
          Never babysit charts again.{" "}
          <span className="font-medium text-fg">Nothing trades without your signature.</span>
        </p>

        {aiOn ? <HeroComposer onInteract={noteInteraction} /> : <MarketSearch />}

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/strategies/new?start=blank"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:border-border-strong hover:bg-surface-2"
          >
            <Hammer size={14} aria-hidden />
            Build manually
          </Link>
          <Link
            href="/strategies/new"
            className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
          >
            start from a template →
          </Link>
          <Link
            href="/markets"
            className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
          >
            browse markets →
          </Link>
        </div>
      </div>

      {/* ── Show, don't tell: the demo types below, the strategy assembles live ── */}
      <div
        className="mx-auto w-full max-w-3xl space-y-2"
        onMouseEnter={aiOn ? () => setHovered(true) : undefined}
        onMouseLeave={aiOn ? () => setHovered(false) : undefined}
      >
        {aiOn ? (
          <>
            <DemoTyper segments={demo.visibleSegments} caret={!reduced} />
            <StrategyPreviewPanel
              scenario={active}
              revealedChips={demo.revealedChips}
              showMarkers={demo.showMarkers}
              binding={binding}
              idx={idx}
              count={DEMO_SCENARIOS.length}
              goTo={demo.goTo}
            />
          </>
        ) : (
          <SmartOrderPreview />
        )}
      </div>
    </section>
  );
}
