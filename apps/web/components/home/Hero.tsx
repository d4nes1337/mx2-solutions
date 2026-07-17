"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { LiveDot } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";
import { useFeatureFlags, useShowcases } from "@/lib/queries";
import { DEMO_SCENARIOS } from "@/lib/home/demo-scenarios";
import { useDemoPlayer } from "@/lib/home/use-demo-player";
import { useScenarioBinding } from "@/lib/home/use-scenario-binding";
import { TEMPLATES } from "@/lib/smart-orders/templates";
import type { Showcase } from "@/lib/types";
import { Chip } from "./ShowcaseCard";
import { DemoTyper } from "./DemoTyper";
import { HeroChat } from "./HeroChat";
import { StrategyPreviewPanel } from "./StrategyPreviewPanel";

/** Demo resumes this long after the user's last composer touch. */
const IDLE_RESUME_MS = 8_000;

/** Static, decorative preview of what a Smart Order looks like. */
function SmartOrderPreview() {
  return (
    <div className="glass rounded-xl p-5 shadow-elev">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Smart Order · Re-entry
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
      className="flex max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-panel focus-within:border-brand"
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

/** Fallback example thoughts — the templates' prompt lines plus a few bespoke. */
const FALLBACK_EXAMPLES = [
  ...TEMPLATES.map((t) => t.prompt),
  "Buy YES on the Fed cutting rates if it dips below 40¢.",
  "Every time the Bitcoin $150k market drops 5¢, alert me.",
];

/** Concrete prompts derived from live showcases — real markets beat abstractions. */
const examplesFrom = (showcases: Showcase[] | undefined): string[] => {
  if (!showcases || showcases.length === 0) return FALLBACK_EXAMPLES;
  const dynamic = showcases
    .slice(0, 3)
    .map((s) => s.prompt ?? `Buy the dip on ${s.market.title.slice(0, 60)}`);
  return [...dynamic, ...FALLBACK_EXAMPLES.slice(0, 2)];
};

export function Hero() {
  const flags = useFeatureFlags();
  const aiOn = flags.data?.aiChat === true;
  const sc = useShowcases();
  const reduced = useReducedMotion();

  // Hovering either column or touching the composer pauses the demo; it
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

  // Single owner of the demo state: chat typer, preview chips, chart markers
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

  const pause = aiOn ? () => setHovered(true) : undefined;
  const resume = aiOn ? () => setHovered(false) : undefined;

  return (
    <section className="grid grid-cols-1 items-center gap-8 py-6 lg:grid-cols-2 lg:py-10">
      <div className="space-y-5" onMouseEnter={pause} onMouseLeave={resume}>
        <h1 className="text-hero font-bold tracking-tight text-fg sm:text-hero-lg">
          {aiOn ? (
            <>
              Type a thought.
              <br />
              <span className="text-accent">Watch it become a strategy.</span>
            </>
          ) : (
            <>
              Build smart Polymarket orders.
              <br />
              <span className="text-accent">Visually.</span>
            </>
          )}
        </h1>
        <p className="max-w-md text-[15px] leading-relaxed text-muted">
          {aiOn
            ? "Describe a trade in plain words — AI assembles a live Polymarket strategy on a visual canvas, with real prices and an instant payoff projection."
            : "No code. No spreadsheets. Just logic — templates, conditions across markets, and an optional no-popup trading wallet."}
        </p>
        {aiOn ? (
          <HeroChat
            demo={<DemoTyper segments={demo.visibleSegments} caret={!reduced} />}
            examples={examplesFrom(sc.data?.showcases)}
            onInteract={noteInteraction}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/smart-orders/new"
              className="inline-flex items-center gap-2 rounded-lg border border-brand bg-brand px-5 py-2.5 text-[15px] font-semibold text-white shadow-[0_0_18px_-6px_rgba(var(--brand-rgb),0.35)] transition-colors hover:border-brand-strong hover:bg-brand-strong"
            >
              <Sparkles size={16} aria-hidden />
              Create Smart Order
            </Link>
            <Link
              href="/markets"
              className="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:border-border-strong hover:bg-surface-2"
            >
              Browse markets
            </Link>
          </div>
        )}
        {aiOn ? (
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/smart-orders/new"
              className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
            >
              or start from a template →
            </Link>
            <Link
              href="/markets"
              className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
            >
              browse markets →
            </Link>
          </div>
        ) : (
          <MarketSearch />
        )}
      </div>
      <div className="relative" onMouseEnter={pause} onMouseLeave={resume}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-mark-gradient.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 -z-10 hidden w-56 select-none lg:block"
        />
        {aiOn ? (
          <StrategyPreviewPanel
            scenario={active}
            revealedChips={demo.revealedChips}
            showMarkers={demo.showMarkers}
            binding={binding}
            idx={idx}
            count={DEMO_SCENARIOS.length}
            goTo={demo.goTo}
          />
        ) : (
          <SmartOrderPreview />
        )}
      </div>
    </section>
  );
}
