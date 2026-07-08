"use client";

import { Hero } from "@/components/home/Hero";
import { TemplateGallery } from "@/components/home/TemplateGallery";
import { HotMarkets } from "@/components/home/HotMarkets";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <Hero />
      <TemplateGallery />
      <HotMarkets />
    </div>
  );
}
