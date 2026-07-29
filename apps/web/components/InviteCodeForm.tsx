"use client";

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type { useSignIn } from "@/lib/auth";
import { getStoredRefCode } from "@/lib/referral";
import { useWaitlistUi } from "@/lib/waitlist-ui";

/** Sign-in error codes that mean "beta access required", not "sign-in broke". */
export function isAccessError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "NOT_ALLOWLISTED" || error.code === "INVITE_INVALID")
  );
}

/**
 * The private-beta gate shown when a valid wallet signature is not (yet)
 * invited: redeem a one-time invitation code (re-signs a fresh challenge with
 * the code attached) or join the waitlist. Rendered by the header account menu
 * and the builder save panel — one implementation, two mounts.
 */
export function InviteCodeForm({
  signIn,
  heading = "Private beta access is required to save, arm, and receive live triggers.",
}: {
  signIn: ReturnType<typeof useSignIn>;
  heading?: string;
}) {
  const [code, setCode] = useState("");

  // Pre-fill a code captured from a /r/CODE or ?ref= link (effect, not
  // initializer: localStorage must not influence the hydration pass).
  useEffect(() => {
    const stored = getStoredRefCode();
    if (stored) setCode((prev) => (prev === "" ? stored : prev));
  }, []);

  const invalidCode =
    signIn.error instanceof ApiError && signIn.error.code === "INVITE_INVALID"
      ? signIn.error.message
      : null;

  return (
    <div className="space-y-2.5 text-left">
      <p className="text-[12px] leading-snug text-muted">{heading}</p>
      <form
        className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 focus-within:border-brand"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = code.trim();
          if (trimmed) signIn.mutate({ inviteCode: trimmed });
        }}
      >
        <KeyRound size={13} className="shrink-0 text-faint" aria-hidden />
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Invitation code"
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          aria-label="Invitation code"
        />
        <Button size="sm" type="submit" disabled={signIn.isPending || code.trim().length === 0}>
          {signIn.isPending ? "Check wallet…" : "Redeem"}
        </Button>
      </form>
      {invalidCode ? <p className="text-[11px] leading-snug text-neg">{invalidCode}</p> : null}
      <p className="text-[11px] leading-snug text-muted">
        No code yet?{" "}
        <button
          type="button"
          onClick={() => useWaitlistUi.getState().openModal()}
          className="text-accent hover:underline"
        >
          Join the waitlist
        </button>{" "}
        — we invite a small group of active traders at a time.
      </p>
    </div>
  );
}
