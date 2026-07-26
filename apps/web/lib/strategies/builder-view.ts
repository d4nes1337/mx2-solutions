"use client";

/**
 * Which projection the builder shows — the grid (default) or the node canvas.
 * Persisted per device; NEXT_PUBLIC_GRID_BUILDER=0 flips the default back to
 * the canvas (rollout lever for the grid-builder slice).
 */
export type BuilderView = "grid" | "canvas";

const KEY = "arima.builder.view.v1";

export const DEFAULT_BUILDER_VIEW: BuilderView =
  process.env.NEXT_PUBLIC_GRID_BUILDER === "0" ? "canvas" : "grid";

export const loadBuilderView = (): BuilderView => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "canvas" || v === "grid" ? v : DEFAULT_BUILDER_VIEW;
  } catch {
    return DEFAULT_BUILDER_VIEW;
  }
};

export const saveBuilderView = (view: BuilderView): void => {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // Private-mode storage failures are non-fatal — the toggle just won't stick.
  }
};
