"use client";

/**
 * Below-the-hero discovery (Slice 6): left = proof ("Proven plays" —
 * backtested strategies on real markets), right = action ("Automate these
 * markets now" — live markets with a one-click best-fit strategy).
 */
import { ProvenPlays } from "./ProvenPlays";
import { AutomateNow } from "./AutomateNow";

export function DiscoverySection() {
  return (
    <section className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <ProvenPlays />
      <AutomateNow />
    </section>
  );
}
