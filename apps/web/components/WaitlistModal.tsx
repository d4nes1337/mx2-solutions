"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Wallet, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";
import { useWaitlistUi } from "@/lib/waitlist-ui";

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-fg outline-none placeholder:text-faint focus:border-brand";

/**
 * The private-beta waitlist pop-up (owner decision 2026-07-23: a modal, not a
 * page) — deliberately tiny: an email and/or the connected wallet plus explicit
 * consent, with a minimal privacy note. Mounted once in AppChrome, opened via
 * the waitlist-ui store.
 */
export function WaitlistModal() {
  const { open, closeModal } = useWaitlistUi();
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);

  const submit = useMutation({
    mutationFn: async () =>
      api.post<{ ok: boolean; status: string }>("/api/waitlist", {
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(address ? { walletAddress: address } : {}),
        consent: true,
      }),
  });

  const error =
    submit.error instanceof ApiError || submit.error instanceof Error ? submit.error.message : null;
  const canSubmit = consent && (email.trim().length > 0 || Boolean(address));

  const close = () => {
    closeModal();
    // A finished submission resets on close so reopening starts fresh.
    if (submit.isSuccess) {
      submit.reset();
      setEmail("");
      setConsent(false);
    }
  };

  return (
    <SheetShell
      open={open}
      onClose={close}
      label="Join the private beta waitlist"
      panelClassName="w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-panel sm:rounded-2xl"
    >
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="absolute right-3 top-3 rounded-md p-1 text-muted transition-colors hover:text-fg"
      >
        <X size={16} aria-hidden />
      </button>

      {submit.isSuccess ? (
        <div className="space-y-3 pt-2 text-center">
          <CheckCircle2 size={28} className="mx-auto text-pos" aria-hidden />
          <h2 className="text-lg font-semibold text-fg">You&apos;re on the list</h2>
          <p className="text-[13px] leading-relaxed text-muted">
            We invite a small group of active traders at a time. When it&apos;s your turn,
            you&apos;ll get a one-time invitation code — redeem it at sign-in to unlock saving,
            arming, and live trigger alerts. Until then, you can keep building and simulating
            strategies freely.
          </p>
          <Button className="w-full" onClick={close}>
            Keep drafting
          </Button>
        </div>
      ) : (
        <>
          <h2 className="pr-6 text-lg font-semibold text-fg">Join the private beta</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            Free private beta for active Polymarket traders. Drafting and simulating is open to
            everyone; saving, arming, and live alerts need an invitation. Leave an email, connect
            your wallet, or both.
          </p>

          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submit.mutate();
            }}
          >
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-fg">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputCls}
                autoComplete="email"
              />
            </label>

            {address ? (
              <p className="flex items-center gap-1.5 text-[12px] text-muted">
                <Wallet size={13} aria-hidden className="text-pos" />
                Wallet{" "}
                <span className="font-mono">
                  {address.slice(0, 6)}…{address.slice(-4)}
                </span>{" "}
                will be attached.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => openConnectModal?.()}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-fg transition-colors hover:border-border-strong"
              >
                <Wallet size={14} aria-hidden />
                …or connect your wallet instead
              </button>
            )}

            <label className="flex items-start gap-2 text-[12px] leading-snug text-muted">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
                required
              />
              <span>
                I agree that Arima stores this to manage beta access and contact me about the beta.
                Nothing is shared; deleted on request. *
              </span>
            </label>

            {error ? <p className="text-[12px] text-neg">{error}</p> : null}

            <Button type="submit" className="w-full" disabled={submit.isPending || !canSubmit}>
              {submit.isPending ? "Joining…" : "Join the waitlist"}
            </Button>

            <p className="text-center text-[11px] text-muted">
              Free private beta · Your wallet first · Automation is optional
            </p>
          </form>
        </>
      )}
    </SheetShell>
  );
}
