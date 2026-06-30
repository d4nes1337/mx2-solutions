"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useSession, useSignIn, useSignOut } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { Badge, Button, cn } from "./ui";

const NAV = [
  { href: "/", label: "Markets" },
  { href: "/rules", label: "Rules" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/profile", label: "Profile" },
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
      <span className="grid h-7 w-7 place-items-center rounded-md bg-brand shadow-[0_0_18px_-4px_rgba(42,54,255,0.8)]">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M2 11.5 L6 7 L9 9.5 L14 3.5"
            stroke="white"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="14" cy="3.5" r="1.4" fill="white" />
        </svg>
      </span>
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
      <div className="flex items-center gap-2">
        <Badge tone={session.data.allowlisted ? "pos" : "warn"} dot>
          {session.data.allowlisted ? "allowlisted" : "not allowlisted"}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
        >
          Sign out
        </Button>
      </div>
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
