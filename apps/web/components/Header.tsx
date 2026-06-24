"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useSession, useSignIn, useSignOut } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { Badge, Button, cn } from "./ui";

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "rounded px-2 py-1 text-sm transition-colors",
        active ? "text-fg" : "text-muted hover:text-fg",
      )}
    >
      {label}
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
        <Badge tone={session.data.allowlisted ? "pos" : "warn"}>
          {session.data.allowlisted ? "allowlisted" : "not allowlisted"}
        </Badge>
        <Button variant="ghost" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
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
      {err ? <span className="max-w-[220px] truncate text-xs text-neg">{err}</span> : null}
      <Button onClick={() => signIn.mutate()} disabled={signIn.isPending}>
        {signIn.isPending ? "Check wallet…" : "Sign in"}
      </Button>
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between px-3 py-2">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm font-bold tracking-tight">
            MX2 <span className="text-accent">Terminal</span>
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink href="/" label="Markets" />
            <NavLink href="/rules" label="Rules" />
            <NavLink href="/profile" label="Profile" />
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <SessionControls />
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
        </div>
      </div>
    </header>
  );
}
