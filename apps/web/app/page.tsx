"use client";

import { Hero } from "@/components/home/Hero";
import { ShowcaseGallery } from "@/components/home/ShowcaseGallery";
import { HotMarkets } from "@/components/home/HotMarkets";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <Hero />
      <ShowcaseGallery />
      <HotMarkets />
    </div>
  );
}
