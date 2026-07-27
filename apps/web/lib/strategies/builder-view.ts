"use client";

/**
 * How tall the canvas strip sits under the grid. The canvas is no longer a
 * separate view behind a toggle nobody found — it is always on screen as a
 * peek strip and expands in place. Persisted per device.
 */
export type CanvasHeight = "peek" | "tall";

const KEY = "arima.builder.canvas-height.v1";

export const DEFAULT_CANVAS_HEIGHT: CanvasHeight = "peek";

export const loadCanvasHeight = (): CanvasHeight => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "tall" || v === "peek" ? v : DEFAULT_CANVAS_HEIGHT;
  } catch {
    return DEFAULT_CANVAS_HEIGHT;
  }
};

export const saveCanvasHeight = (height: CanvasHeight): void => {
  try {
    localStorage.setItem(KEY, height);
  } catch {
    // Private-mode storage failures are non-fatal — the choice just won't stick.
  }
};
