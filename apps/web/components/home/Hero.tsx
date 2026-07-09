"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { LiveDot } from "@/components/ui";

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

export function Hero() {
  return (
    <section className="grid grid-cols-1 items-center gap-8 py-6 lg:grid-cols-2 lg:py-10">
      <div className="space-y-5">
        <h1 className="text-hero font-bold tracking-tight text-fg sm:text-hero-lg">
          Build smart Polymarket orders.
          <br />
          <span className="text-accent">Visually.</span>
        </h1>
        <p className="max-w-md text-[15px] leading-relaxed text-muted">
          No code. No spreadsheets. Just logic — templates, conditions across markets, and an
          optional no-popup trading wallet.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/smart-orders/new"
            className="inline-flex items-center gap-2 rounded-lg border border-brand bg-brand px-5 py-2.5 text-[15px] font-semibold text-white shadow-[0_0_18px_-6px_rgba(42,54,255,0.35)] transition-colors hover:border-brand-strong hover:bg-brand-strong"
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
        <MarketSearch />
      </div>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-mark-gradient.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 -z-10 hidden w-56 select-none lg:block"
        />
        <SmartOrderPreview />
      </div>
    </section>
  );
}
