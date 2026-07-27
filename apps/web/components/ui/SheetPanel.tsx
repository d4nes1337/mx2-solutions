"use client";

/**
 * Standard dialog chrome on top of SheetShell: opaque surface, sticky header
 * with title + close, scrollable body, optional sticky footer. Every builder
 * dialog uses this so none can ship a transparent or unscrollable panel by
 * forgetting a class — the failure mode that made several sheets unreadable.
 *
 * Sizes map to intent: `sm` confirmations, `md` single-purpose editors,
 * `lg` search/browse, `xl` conversational surfaces.
 */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";

const SIZE: Record<"sm" | "md" | "lg" | "xl", string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
};

export function SheetPanel({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  /** Body gets no padding — for panels that manage their own (e.g. a chat). */
  flushBody = false,
  bodyClassName,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  flushBody?: boolean;
  bodyClassName?: string;
}) {
  return (
    <SheetShell
      open={open}
      onClose={onClose}
      label={title}
      panelClassName={cn(
        // Bottom sheet on mobile, centered card on desktop. `bg-bg` (not
        // surface) keeps nested surface-2 controls readable against it.
        "flex max-h-[92svh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-bg shadow-xl sm:max-h-[86svh] sm:rounded-xl",
        SIZE[size],
      )}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-fg">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[12px] leading-snug text-muted">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-mr-1 shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          flushBody ? "" : "px-4 py-4",
          bodyClassName,
        )}
      >
        {children}
      </div>

      {footer ? (
        <div className="shrink-0 border-t border-border bg-bg px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {footer}
        </div>
      ) : null}
    </SheetShell>
  );
}
