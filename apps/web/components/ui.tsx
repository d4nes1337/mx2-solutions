import type { ReactNode, ButtonHTMLAttributes } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-sm border border-border bg-surface", className)}>{children}</div>
  );
}

export function CardHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b border-border px-4 py-3 text-sm font-semibold", className)}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "pos" | "neg" | "warn" | "accent";
}) {
  const tones: Record<string, string> = {
    neutral: "border-border text-muted",
    pos: "border-pos/40 text-pos",
    neg: "border-neg/40 text-neg",
    warn: "border-warn/40 text-warn",
    accent: "border-accent/40 text-accent",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const variants: Record<string, string> = {
    primary: "bg-accent/15 text-accent border-accent/40 hover:bg-accent/25",
    ghost: "bg-transparent text-fg border-border hover:bg-surface-2",
    danger: "bg-neg/15 text-neg border-neg/40 hover:bg-neg/25",
  };
  return (
    <button
      className={cn(
        "rounded-sm border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variants[variant],
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
}: {
  label: string;
  value: ReactNode;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="rounded-sm border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={cn(
          "tabular mt-1 text-lg font-semibold",
          tone === "pos" && "text-pos",
          tone === "neg" && "text-neg",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      {label ?? "Loading…"}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-sm border border-neg/40 bg-neg/10 px-3 py-2 text-sm text-neg">
      {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-sm border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}
