"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWaitlistUi } from "@/lib/waitlist-ui";

/**
 * Deep-link for the waitlist pop-up (owner decision 2026-07-23: the waitlist
 * is a modal, not a page). /waitlist stays shareable — it lands on the home
 * page with the modal open.
 */
export default function WaitlistPage() {
  const router = useRouter();
  useEffect(() => {
    useWaitlistUi.getState().openModal();
    router.replace("/");
  }, [router]);
  return null;
}
