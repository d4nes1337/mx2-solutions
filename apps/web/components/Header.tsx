"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "@/components/brand/LogoMark";
import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";
import { AccountMenu } from "@/components/AccountMenu";
import { HelpButton } from "@/components/onboarding/HelpButton";
import { cn } from "./ui";

const NAV = [
  { href: "/", label: "Home", tour: null },
  { href: "/markets", label: "Markets", tour: "nav-markets" },
  { href: "/smart-orders", label: "Smart Orders", tour: "nav-smart-orders" },
  { href: "/wallet", label: "Wallet", tour: "nav-wallet" },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavLink({
  href,
  label,
  mobile,
  tour,
}: {
  href: string;
  label: string;
  mobile?: boolean;
  tour?: string | null;
}) {
  const pathname = usePathname();
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      {...(tour && !mobile ? { "data-tour": tour } : {})}
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
      <LogoMark className="h-7 w-auto text-brand drop-shadow-[0_2px_8px_rgba(var(--brand-rgb),0.3)]" />
      <span className="text-[17px] font-bold lowercase tracking-tight text-fg">arima</span>
    </Link>
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
              <NavLink key={n.href} href={n.href} label={n.label} tour={n.tour} />
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <HelpButton />
          <ThemeSwitcher />
          <AccountMenu />
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
