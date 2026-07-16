"use client";

/**
 * Width state for the builder's resizable workspace panel. Pointer-dragging
 * the PanelResizeHandle (or arrow keys on it) resizes within [MIN, MAX]; the
 * chosen width persists per browser. The server render uses the default and
 * the stored value lands after mount (same pattern as the theme provider).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const PANEL_WIDTH_MIN = 320;
export const PANEL_WIDTH_MAX = 640;
export const PANEL_WIDTH_DEFAULT = 384;
export const PANEL_WIDTH_STORAGE_KEY = "arima.builder.panelWidth";

const clamp = (w: number): number =>
  Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(w)));

export function usePanelWidth() {
  const [width, setWidth] = useState(PANEL_WIDTH_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
      if (Number.isFinite(stored) && stored > 0) setWidth(clamp(stored));
    } catch {
      // Non-persistent is fine.
    }
  }, []);

  const persist = (w: number) => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(w));
    } catch {
      // Non-persistent is fine.
    }
  };

  /** pointerdown on the handle: the panel is on the RIGHT, so dragging left widens it. */
  const startDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is an optimization (keeps events flowing off-element); some
      // synthetic pointers can't be captured — the window listeners still work.
    }
    setDragging(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    let frame = 0;
    let pending = startW;
    const onMove = (ev: PointerEvent) => {
      pending = clamp(startW + (startX - ev.clientX));
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setWidth(pending);
      });
    };
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame);
      setWidth(pending);
      persist(pending);
      setDragging(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = clamp(widthRef.current + step);
    else if (e.key === "ArrowRight") next = clamp(widthRef.current - step);
    else if (e.key === "Home") next = PANEL_WIDTH_MAX;
    else if (e.key === "End") next = PANEL_WIDTH_MIN;
    if (next === null) return;
    e.preventDefault();
    setWidth(next);
    persist(next);
  }, []);

  return { width, dragging, startDrag, onKeyDown };
}
