"use client";

import { useEffect, useRef } from "react";

/**
 * Invisible scroll sentinel: fires `onVisible` when it approaches the viewport
 * (600px early so the next page lands before the user hits the fold). The page
 * scrolls the document body (AppChrome), so the default viewport root is
 * correct. Callers guard with `disabled` while a fetch is in flight or when
 * there is nothing more to load.
 */
export function InfiniteSentinel({
  onVisible,
  disabled,
}: {
  onVisible: () => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (disabled || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onVisible();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible, disabled]);

  return <div ref={ref} className="h-px" aria-hidden />;
}
