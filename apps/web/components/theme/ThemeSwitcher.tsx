"use client";

import { Moon, Newspaper, Sun } from "lucide-react";
import { THEMES, useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/components/ui";

const META: Record<Theme, { label: string; Icon: typeof Sun }> = {
  light: { label: "Light", Icon: Sun },
  paper: { label: "Paper", Icon: Newspaper },
  dark: { label: "Dark", Icon: Moon },
};

/** Compact header control cycling the three app themes (light / paper / dark). */
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const { Icon, label } = META[theme];

  return (
    <details className="group relative" data-tour="theme-switcher">
      <summary
        aria-label={`Theme: ${label}`}
        title="Theme"
        className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm font-medium text-fg transition-colors hover:border-border-strong [&::-webkit-details-marker]:hidden"
      >
        <Icon className="h-4 w-4" aria-hidden />
        <span className="text-[10px] text-faint transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="absolute right-0 top-full z-40 mt-1.5 w-36 space-y-0.5 rounded-lg border border-border bg-surface p-1.5 shadow-pop">
        {THEMES.map((t) => {
          const { label: itemLabel, Icon: ItemIcon } = META[t];
          return (
            <button
              key={t}
              type="button"
              aria-pressed={t === theme}
              onClick={(event) => {
                setTheme(t);
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                t === theme
                  ? "bg-surface-2 font-medium text-fg"
                  : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <ItemIcon className="h-4 w-4" aria-hidden />
              {itemLabel}
              {t === theme ? <span className="ml-auto text-[10px] text-accent">✓</span> : null}
            </button>
          );
        })}
      </div>
    </details>
  );
}
