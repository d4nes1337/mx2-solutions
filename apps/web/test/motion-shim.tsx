/**
 * Test double for "motion/react": every `m.<tag>` renders the plain element
 * (motion props stripped), AnimatePresence/LazyMotion render children
 * directly. Wired via the vitest alias in vitest.config.mts so component
 * tests never load the animation runtime (jsdom has no rAF-driven layout).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { forwardRef, type ReactNode } from "react";

const MOTION_PROPS = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
  "layout",
  "layoutId",
  "whileHover",
  "whileTap",
  "whileFocus",
  "whileInView",
  "onAnimationStart",
  "onAnimationComplete",
]);

const passthrough = (tag: string) =>
  forwardRef<any, any>((props, ref) => {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (!MOTION_PROPS.has(key)) clean[key] = value;
    }
    return React.createElement(tag, { ...clean, ref });
  });

const cache = new Map<string, ReturnType<typeof passthrough>>();

export const m: any = new Proxy(
  {},
  {
    get: (_target, tag: string) => {
      if (!cache.has(tag)) cache.set(tag, passthrough(tag));
      return cache.get(tag);
    },
  },
);

export const AnimatePresence = ({ children }: { children?: ReactNode }) => <>{children}</>;
export const LazyMotion = ({ children }: { children?: ReactNode }) => <>{children}</>;
export const domMax = {};
export type Transition = Record<string, unknown>;
