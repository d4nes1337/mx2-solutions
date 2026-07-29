"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { KeyRound } from "lucide-react";
import { getStoredRefCode, storeRefCode } from "@/lib/referral";
import { useSession } from "@/lib/auth";

function CatcherInner() {
  const params = useSearchParams();
  const session = useSession();
  const [captured, setCaptured] = useState<string | null>(null);

  // ?ref=CODE anywhere in the app (marketing links, shared URLs) is captured
  // exactly like /r/CODE. Reading localStorage in an effect keeps SSR markup
  // stable (no hydration mismatch).
  useEffect(() => {
    const ref = params.get("ref");
    if (ref) {
      const stored = storeRefCode(ref);
      if (stored) setCaptured(stored);
      return;
    }
    if (params.get("ref-applied")) setCaptured(getStoredRefCode());
  }, [params]);

  // Only worth announcing while the visitor is still signed out.
  if (!captured || session.data) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-fg shadow-lg">
        <KeyRound size={13} className="text-accent" aria-hidden />
        <span>
          Invite code <span className="font-mono font-semibold">{captured}</span> will be applied
          when you sign in.
        </span>
        <button
          type="button"
          onClick={() => setCaptured(null)}
          className="ml-1 text-muted hover:text-fg"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** useSearchParams needs a Suspense boundary in the App Router. */
export function RefCodeCatcher() {
  return (
    <Suspense fallback={null}>
      <CatcherInner />
    </Suspense>
  );
}
