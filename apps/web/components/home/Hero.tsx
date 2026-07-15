"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Search, Sparkles } from "lucide-react";
import { LiveDot } from "@/components/ui";
import { useReducedMotion } from "@/components/motion";
import { AreaChart } from "@/components/charts/AreaChart";
import { useFeatureFlags, useShowcases } from "@/lib/queries";
import { signedUsd } from "@/lib/format";
import { TEMPLATES } from "@/lib/smart-orders/templates";
import type { Showcase } from "@/lib/types";

/** A chip in the static hero preview of a Smart Order sentence. */
function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    neutral: "border-border bg-surface text-fg",
    brand: "border-brand/40 bg-brand-soft text-accent",
    pos: "border-pos/30 bg-pos/10 text-pos",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[12px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

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

/** Fallback example thoughts — the templates' NL strings plus a few bespoke. */
const FALLBACK_EXAMPLES = [
  ...TEMPLATES.map((t) => t.example),
  "Buy YES on the Fed cutting rates if it dips below 40¢.",
  "Every time the Bitcoin $150k market drops 5¢, alert me.",
];

/** Concrete prompts derived from live showcases — real markets beat abstractions. */
const examplesFrom = (showcases: Showcase[] | undefined): string[] => {
  if (!showcases || showcases.length === 0) return FALLBACK_EXAMPLES;
  const dynamic = showcases.slice(0, 3).map((s) => promptFor(s));
  return [...dynamic, ...FALLBACK_EXAMPLES.slice(0, 2)];
};

/** The chat text that builds a showcase (server-generated, with a fallback). */
const promptFor = (s: Showcase): string =>
  s.prompt ?? `Buy the dip on ${s.market.title.slice(0, 60)}`;

/**
 * The vibe-trading entry: type a thought → land in the builder with the AI
 * assembling the canvas. Only rendered when the aiChat flag is on.
 */
function AiPromptCard({
  examples,
  seed,
}: {
  examples: string[];
  /** Externally injected prompt (the carousel's "Try this prompt"); bump nonce to re-apply. */
  seed?: { text: string; nonce: number } | null;
}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [q, setQ] = useState("");
  const [phIdx, setPhIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setPhIdx((i) => (i + 1) % examples.length), 3_500);
    return () => clearInterval(t);
  }, [reduced, examples.length]);

  useEffect(() => {
    if (!seed) return;
    setQ(seed.text);
    inputRef.current?.focus();
    // Optional-call: jsdom has no scrollIntoView.
    inputRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  const go = (raw: string) => {
    const v = raw.trim().slice(0, 500);
    if (v.length < 3) return;
    router.push(`/smart-orders/new?prompt=${encodeURIComponent(v)}`);
  };

  return (
    <div className="max-w-lg space-y-2.5" data-tour="hero-prompt">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        className="rounded-xl border border-brand/40 bg-surface p-2.5 shadow-[0_0_24px_-8px_rgba(var(--brand-rgb),0.35)] focus-within:border-brand"
      >
        <textarea
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              go(q);
            }
          }}
          rows={3}
          maxLength={500}
          placeholder={examples[phIdx % examples.length]}
          aria-label="Describe your trading idea"
          className="w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="pl-1.5 text-[11px] text-faint">
            Free — no account needed to build &amp; simulate
          </span>
          <button
            type="submit"
            disabled={q.trim().length < 3}
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand bg-brand px-4 py-2 text-[14px] font-semibold text-white transition-colors hover:border-brand-strong hover:bg-brand-strong disabled:opacity-40"
          >
            <Sparkles size={14} aria-hidden />
            Build it
          </button>
        </div>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {examples.slice(0, 3).map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setQ(ex)}
            className="rounded-full border border-border bg-surface px-2.5 py-1 text-left text-[11px] text-muted transition-colors hover:border-border-strong hover:text-fg"
          >
            {ex.length > 56 ? `${ex.slice(0, 53)}…` : ex}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A REAL trending market with its REAL 30-day backtest, replacing the old
 * hardcoded marketing mock. Everything on it is live data; the disclaimer
 * keeps the selection-bias honesty bar (R-023).
 */
function LiveShowcasePreview({ showcase }: { showcase: Showcase }) {
  const action = showcase.definition.action;
  const entryCents =
    action.kind === "order" ? Math.round(action.price * 100) : showcase.market.currentPriceCents;

  return (
    <div className="glass rounded-xl p-5 shadow-elev">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Live showcase · Dip-buy
        </span>
        <LiveDot label="BACKTESTED" />
      </div>
      <div className="mt-3 line-clamp-2 text-[14px] font-semibold leading-snug text-fg">
        {showcase.market.title}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 leading-relaxed">
        <Chip>If</Chip>
        <Chip tone="brand">{showcase.market.outcome} price</Chip>
        <Chip>dips below {entryCents}¢</Chip>
        <Chip>for 15 minutes</Chip>
        <span className="mx-1 text-muted">→</span>
        <Chip tone="pos">Buy $100 at {entryCents}¢</Chip>
      </div>
      <AreaChart
        data={showcase.series.map((pt) => ({ t: pt.t, v: pt.p }))}
        height={96}
        showAxis={false}
        markers={showcase.triggers.map((tr) => ({
          t: tr.t,
          label: `trigger @ ${Math.round(tr.price * 100)}¢`,
        }))}
        valueFormat={(v) => `${Math.round(v * 100)}¢`}
        className="mt-3"
      />
      <div className="mt-3 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
        <span className="tabular text-[12px] font-semibold text-pos">
          {signedUsd(showcase.stats.hypotheticalPnlUsd)} across {showcase.stats.triggerCount} × $
          {showcase.stats.stakeUsd} dip-buy{showcase.stats.triggerCount > 1 ? "s" : ""} · last{" "}
          {showcase.stats.windowDays}d
        </span>
        <Link
          href={`/smart-orders/new?showcase=${encodeURIComponent(showcase.id)}`}
          className="text-[12px] font-semibold text-accent hover:text-brand-strong"
        >
          Open this strategy →
        </Link>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-faint">
        Hypothetical backtest on real prices — past performance doesn&apos;t predict the future.
      </p>
    </div>
  );
}

/**
 * Rotates the best backtested market+strategy pairs, each with the chat
 * prompt that would build it. Auto-advances (paused on hover, disabled under
 * prefers-reduced-motion); dots + arrows for manual control.
 */
function ShowcaseCarousel({
  showcases,
  aiOn,
  onUsePrompt,
}: {
  showcases: Showcase[];
  aiOn: boolean;
  onUsePrompt: (text: string) => void;
}) {
  const reduced = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = Math.min(showcases.length, 4);

  useEffect(() => {
    if (reduced || paused || count <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % count), 7_000);
    return () => clearInterval(t);
  }, [reduced, paused, count]);

  const sc = showcases[idx % count]!;
  const prompt = promptFor(sc);

  return (
    <div
      className="space-y-2.5"
      data-tour="hero-showcase"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div key={sc.id} className="fade-in">
        <LiveShowcasePreview showcase={sc} />
      </div>

      {/* The thought that builds it — chat voice, straight into the prompt box. */}
      <div className="glass flex items-center justify-between gap-3 rounded-xl px-4 py-2.5">
        <p className="min-w-0 text-[12px] leading-relaxed text-muted">
          <span className="select-none text-faint">“</span>
          <span className="italic text-fg">{prompt}</span>
          <span className="select-none text-faint">”</span>
        </p>
        {aiOn ? (
          <button
            type="button"
            onClick={() => onUsePrompt(prompt)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand/40 bg-brand-soft px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:border-brand"
          >
            <Sparkles size={11} aria-hidden />
            Try this prompt
          </button>
        ) : null}
      </div>

      {count > 1 ? (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            aria-label="Previous strategy"
            onClick={() => setIdx((i) => (i - 1 + count) % count)}
            className="rounded-md border border-border bg-surface p-1 text-muted transition-colors hover:text-fg"
          >
            <ChevronLeft size={13} aria-hidden />
          </button>
          <div className="flex items-center gap-1.5">
            {showcases.slice(0, count).map((s, i) => (
              <button
                key={s.id}
                type="button"
                aria-label={`Show strategy ${i + 1} of ${count}`}
                aria-current={i === idx % count}
                onClick={() => setIdx(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === idx % count ? "w-5 bg-brand" : "w-1.5 bg-border-strong hover:bg-muted"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            aria-label="Next strategy"
            onClick={() => setIdx((i) => (i + 1) % count)}
            className="rounded-md border border-border bg-surface p-1 text-muted transition-colors hover:text-fg"
          >
            <ChevronRight size={13} aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Hero() {
  const flags = useFeatureFlags();
  const aiOn = flags.data?.aiChat === true;
  const sc = useShowcases();
  const showcases = sc.data?.showcases ?? [];
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  return (
    <section className="grid grid-cols-1 items-center gap-8 py-6 lg:grid-cols-2 lg:py-10">
      <div className="space-y-5">
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
          <AiPromptCard examples={examplesFrom(sc.data?.showcases)} seed={seed} />
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
        <div className="flex flex-wrap items-center gap-3">
          {aiOn ? (
            <Link
              href="/smart-orders/new"
              className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
            >
              or start from a template →
            </Link>
          ) : null}
          {aiOn ? (
            <Link
              href="/markets"
              className="text-[12px] font-medium text-muted transition-colors hover:text-fg"
            >
              browse markets →
            </Link>
          ) : null}
        </div>
        {aiOn ? null : <MarketSearch />}
      </div>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-mark-gradient.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 -z-10 hidden w-56 select-none lg:block"
        />
        {showcases.length > 0 ? (
          <ShowcaseCarousel
            showcases={showcases}
            aiOn={aiOn}
            onUsePrompt={(text) => setSeed({ text, nonce: Date.now() })}
          />
        ) : (
          <SmartOrderPreview />
        )}
      </div>
    </section>
  );
}
