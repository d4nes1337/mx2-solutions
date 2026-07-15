"use client";

import { Hero } from "@/components/home/Hero";
import { ShowcaseGallery } from "@/components/home/ShowcaseGallery";
import { HotMarkets } from "@/components/home/HotMarkets";
import { HomeTour } from "@/components/onboarding/tours";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <HomeTour />
      <Hero />
      <ShowcaseGallery />
      <HotMarkets />
    </div>
  );
}
