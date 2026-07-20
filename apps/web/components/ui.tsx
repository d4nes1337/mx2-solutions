import type { ReactNode, ButtonHTMLAttributes } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({
  children,
  className,
  glow,
}: {
  children: ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-surface shadow-panel",
        glow && "glow-brand",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  children,
  className,
  right,
}: {
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b border-border px-4 py-3",
        className,
      )}
    >
      <div className="text-[13px] font-semibold tracking-tight text-fg">{children}</div>
      {right ? <div className="flex items-center gap-1.5">{right}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  dot,
  className,
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "pos" | "neg" | "warn" | "accent" | "brand";
  dot?: boolean;
  className?: string;
  /** Hover explanation (native tooltip) for state badges. */
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-border bg-surface-2 text-muted",
    pos: "border-pos/30 bg-pos/10 text-pos",
    neg: "border-neg/30 bg-neg/10 text-neg",
    warn: "border-warn/30 bg-warn/10 text-warn",
    accent: "border-accent/40 bg-accent/10 text-accent",
    brand: "border-brand/50 bg-brand/15 text-accent",
  };
  const dotColor: Record<string, string> = {
    neutral: "bg-muted",
    pos: "bg-pos",
    neg: "bg-neg",
    warn: "bg-warn",
    accent: "bg-accent",
    brand: "bg-brand-strong",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
      {...(title ? { title } : {})}
    >
      {dot ? <span className={cn("h-1.5 w-1.5 rounded-full", dotColor[tone])} /> : null}
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md";
}) {
  const variants: Record<string, string> = {
    primary:
      "border-brand bg-brand text-white hover:bg-brand-strong hover:border-brand-strong shadow-[0_0_18px_-6px_rgba(var(--brand-rgb),0.35)]",
    outline: "border-brand/50 bg-brand/10 text-accent hover:bg-brand/20",
    ghost: "border-border bg-surface-2 text-fg hover:bg-surface-3 hover:border-border-strong",
    danger: "border-neg/50 bg-neg/15 text-neg hover:bg-neg/25",
  };
  const sizes: Record<string, string> = {
    sm: "px-2.5 py-1 text-xs",
    md: "px-3.5 py-1.5 text-sm",
  };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Stat({
  label,
  value,
  tone,
  sub,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "pos" | "neg";
  sub?: ReactNode;
  hint?: string;
}) {
  return (
    <div
      className="rounded-md border border-border bg-surface-2/60 px-4 py-3 transition-colors hover:border-border-strong"
      title={hint}
    >
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className={cn(
          "tabular mt-1.5 text-xl font-semibold leading-none",
          tone === "pos" && "text-pos",
          tone === "neg" && "text-neg",
        )}
      >
        {value}
      </div>
      {sub ? <div className="tabular mt-1.5 text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

/**
 * Segmented control — used for chart ranges, outcome toggles, filters.
 * `grow` stretches it to the container width with equal-width, truncating
 * segments (for narrow panels where the inline-flex default overflows).
 * `grow={N}` wraps into rows of N columns instead of one squeezed row —
 * a first-class prop because Tailwind class order can't override
 * `grid-flow-col` from a caller's className reliably.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
  grow = false,
  className,
}: {
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  grow?: boolean | 2 | 3 | 4;
  className?: string;
}) {
  const wrapCols = typeof grow === "number" ? grow : null;
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-surface-2 p-0.5",
        grow
          ? cn(
              "grid w-full gap-0.5",
              wrapCols === null && "auto-cols-fr grid-flow-col",
              wrapCols === 2 && "grid-cols-2",
              wrapCols === 3 && "grid-cols-3",
              wrapCols === 4 && "grid-cols-4",
            )
          : "inline-flex items-center gap-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[3px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-30",
            size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
            Boolean(grow) && "min-w-0 truncate whitespace-nowrap text-center",
            value === o.value
              ? "bg-brand text-white shadow-[0_0_14px_-6px_rgba(var(--brand-rgb),0.45)]"
              : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
      {label ?? "Loading…"}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} />;
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-neg/40 bg-neg/10 px-3 py-2 text-sm text-neg">
      <span aria-hidden>⚠</span>
      <span>{message}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}

/** Pulsing "live" indicator. */
export function LiveDot({
  label = "LIVE",
  tone = "pos",
}: {
  label?: string;
  tone?: "pos" | "warn" | "neg";
}) {
  const color = tone === "pos" ? "bg-pos" : tone === "warn" ? "bg-warn" : "bg-neg";
  const text = tone === "pos" ? "text-pos" : tone === "warn" ? "text-warn" : "text-neg";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-wide",
        text,
      )}
    >
      <span className={cn("pulse-dot h-1.5 w-1.5 rounded-full", color)} />
      {label}
    </span>
  );
}
