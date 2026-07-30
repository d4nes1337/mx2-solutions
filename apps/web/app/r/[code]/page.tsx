"use client";

/**
 * Referral landing: /r/CODE. Captures the code into localStorage and bounces
 * to the home page — the stored code then rides along automatically with the
 * next sign-in (lib/auth useSignIn), so an invitee never types anything.
 */
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { storeRefCode } from "@/lib/referral";

export default function ReferralLandingPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();

  useEffect(() => {
    if (params.code) storeRefCode(decodeURIComponent(params.code));
    router.replace("/?ref-applied=1");
  }, [params.code, router]);

  // Momentary flash while the redirect resolves.
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-muted">
        <KeyRound size={14} aria-hidden />
        Applying referral code…
      </div>
    </div>
  );
}
