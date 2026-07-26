"use client";

import { Coins, KeyRound, Loader2, Pause, ShieldCheck, SlidersHorizontal, Zap } from "lucide-react";
import { useProvisionTradingWallet } from "@/lib/queries";
import { Badge, Button } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";

/**
 * Explicit "Enable Arima Wallet Beta" confirmation (brief §5.3.6/7). Arima
 * Wallet creation is lazy and opt-in — this dialog is the ONE place a fresh
 * internal (Privy) wallet is provisioned, and only after the user reads what
 * they're turning on. It owns the provision mutation so every entry point
 * routes through the same consent step; it closes itself once the wallet exists.
 */
const POINTS: { icon: typeof Zap; text: string }[] = [
  {
    icon: Coins,
    text: "A separate, ring-fenced balance you top up with only what you want to trade.",
  },
  { icon: Zap, text: "Lets Smart Orders execute automatically, without interrupting you to sign." },
  {
    icon: SlidersHorizontal,
    text: "You set hard per-order, daily, and total spend limits before anything runs.",
  },
  { icon: Pause, text: "Pause, revoke, and withdraw to your login wallet at any time." },
  { icon: KeyRound, text: "We never ask for your seed phrase or your main wallet's private key." },
  {
    icon: ShieldCheck,
    text: "Automation stays subject to feature flags and regional restrictions — it's never on by default.",
  },
];

export function EnableArimaWalletDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const provision = useProvisionTradingWallet();
  const error = provision.error instanceof Error ? provision.error.message : null;

  const confirm = () => {
    provision.mutate(undefined, {
      onSuccess: () => {
        provision.reset();
        onClose();
      },
    });
  };

  const close = () => {
    if (provision.isPending) return;
    provision.reset();
    onClose();
  };

  return (
    <SheetShell
      open={open}
      onClose={close}
      label="Enable Arima Wallet Beta"
      panelClassName="w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-panel sm:rounded-2xl"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-soft text-accent">
          <Zap size={17} aria-hidden />
        </span>
        <div>
          <h2 className="flex items-center gap-1.5 text-[16px] font-semibold text-fg">
            Enable Arima Wallet
            <Badge tone="brand">Beta</Badge>
          </h2>
          <p className="text-[12px] text-muted">Optional automated execution with strict limits.</p>
        </div>
      </div>

      <ul className="mt-4 space-y-2.5">
        {POINTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 text-[13px] leading-snug text-muted">
            <Icon size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <span>{text}</span>
          </li>
        ))}
      </ul>

      {error ? <p className="mt-3 text-[12px] text-neg">{error}</p> : null}

      <div className="mt-5 flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={close} disabled={provision.isPending}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={confirm} disabled={provision.isPending}>
          {provision.isPending ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Zap size={14} aria-hidden />
          )}
          Enable Arima Wallet Beta
        </Button>
      </div>
    </SheetShell>
  );
}
