"use client";

import { Hero } from "@/components/home/Hero";
import { DiscoverySection } from "@/components/home/DiscoverySection";
import { HomeTour } from "@/components/onboarding/tours";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <HomeTour />
      <Hero />
      <DiscoverySection />
    </div>
  );
}
