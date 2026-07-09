"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useSession, useSignIn, useSignOut } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { LogoMark } from "@/components/brand/LogoMark";
import { Badge, Button, cn } from "./ui";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/markets", label: "Markets" },
  { href: "/smart-orders", label: "Smart Orders" },
  { href: "/wallet", label: "Wallet" },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavLink({ href, label, mobile }: { href: string; label: string; mobile?: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      className={cn(
        "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        mobile && "shrink-0",
        active ? "text-fg" : "text-muted hover:text-fg",
      )}
    >
      {label}
      {active ? (
        <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-strong" />
      ) : null}
    </Link>
  );
}

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2">
      <LogoMark className="h-7 w-auto text-brand drop-shadow-[0_2px_8px_rgba(42,54,255,0.3)]" />
      <span className="text-[17px] font-bold lowercase tracking-tight text-fg">arima</span>
    </Link>
  );
}

function SessionControls() {
  const { isConnected } = useAccount();
  const session = useSession();
  const signIn = useSignIn();
  const signOut = useSignOut();

  if (!isConnected) return null;

  if (session.data) {
    return (
      <details className="group relative">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-border-strong [&::-webkit-details-marker]:hidden">
          Account
          <span className="text-[10px] text-faint transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="absolute right-0 top-full z-40 mt-1.5 w-52 space-y-1 rounded-lg border border-border bg-surface p-2 shadow-pop">
          <div className="px-2 py-1">
            <Badge tone={session.data.allowlisted ? "pos" : "warn"} dot>
              {session.data.allowlisted ? "beta access" : "no beta access yet"}
            </Badge>
          </div>
          <Link
            href="/portfolio"
            className="block rounded-md px-2 py-1.5 text-sm text-fg hover:bg-surface-2"
          >
            Portfolio
          </Link>
          <button
            type="button"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            Sign out
          </button>
        </div>
      </details>
    );
  }

  const err =
    signIn.error instanceof ApiError
      ? signIn.error.message
      : signIn.error instanceof Error
        ? signIn.error.message
        : null;

  return (
    <div className="flex items-center gap-2">
      {err ? (
        <span className="hidden max-w-[220px] truncate text-xs text-neg sm:inline">{err}</span>
      ) : null}
      <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
        {signIn.isPending ? "Check wallet…" : "Sign in"}
      </Button>
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-5">
          <Logo />
          <nav className="hidden items-center gap-0.5 md:flex">
            {NAV.map((n) => (
              <NavLink key={n.href} href={n.href} label={n.label} />
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <SessionControls />
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
        </div>
      </div>
      {/* Mobile nav strip */}
      <nav className="no-scrollbar flex items-center gap-0.5 overflow-x-auto border-t border-border px-2 py-1.5 md:hidden">
        {NAV.map((n) => (
          <NavLink key={n.href} href={n.href} label={n.label} mobile />
        ))}
      </nav>
    </header>
  );
}
