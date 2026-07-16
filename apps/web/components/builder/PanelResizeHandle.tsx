"use client";

/**
 * The drag line between the canvas and the workspace panel. A 10px hit area
 * around a 1px visual line; keyboard-resizable for accessibility (arrows,
 * Shift for bigger steps, Home/End for the extremes).
 */
import { cn } from "@/components/ui";
import { PANEL_WIDTH_MAX, PANEL_WIDTH_MIN } from "@/lib/use-panel-width";

export function PanelResizeHandle({
  width,
  dragging,
  onPointerDown,
  onKeyDown,
  className,
}: {
  width: number;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workspace panel"
      aria-valuenow={width}
      aria-valuemin={PANEL_WIDTH_MIN}
      aria-valuemax={PANEL_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        "group relative w-2.5 cursor-col-resize touch-none select-none self-stretch",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full transition-colors",
          dragging ? "bg-brand" : "bg-border group-hover:bg-border-strong group-focus:bg-brand",
        )}
      />
    </div>
  );
}
