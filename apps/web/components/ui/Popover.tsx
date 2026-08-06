"use client";

/**
 * Dependency-free anchored popover: the trigger and panel share one relative
 * wrapper, the panel floats below (right-aligned by default), outside-click
 * and Escape close it, and the first input autofocuses. Small by design — a
 * quick-edit affordance, not a menu system.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { useOutsideClick } from "@/lib/use-outside-click";

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = "end",
  label,
  panelClassName,
  autoFocus = true,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The always-rendered anchor (usually a button toggling `open`). */
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  /** Accessible dialog name. */
  label: string;
  panelClassName?: string;
  /**
   * Focus (and select) the panel's first control on open. Right for quick-edit
   * popovers; wrong for menus, where it would land on whatever button happens
   * to be first (e.g. "Sign out").
   */
  autoFocus?: boolean;
  /** Wrapper classes — the positioned ancestor outside-click is measured against. */
  className?: string;
}) {
  const wrapRef = useOutsideClick<HTMLSpanElement>(open, () => onOpenChange(false));
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !autoFocus) return;
    const first = panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, [open, autoFocus]);

  return (
    <span ref={wrapRef} className={cn("relative inline-flex", className)}>
      {trigger}
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          className={cn(
            "absolute top-full z-30 mt-1.5 min-w-48 rounded-lg border border-border bg-surface p-3 shadow-pop",
            align === "end" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}
