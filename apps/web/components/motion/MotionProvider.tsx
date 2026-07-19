"use client";

/**
 * App-wide LazyMotion host. `strict` guarantees nobody imports the full
 * `motion.*` components by accident — everything animated uses the lazy `m.*`
 * namespace, so the animation runtime (domMax: springs, presence, layout)
 * loads once and stays out of the critical path.
 */
import { LazyMotion, domMax } from "motion/react";
import type { ReactNode } from "react";

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      {children}
    </LazyMotion>
  );
}
