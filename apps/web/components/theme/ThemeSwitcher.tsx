"use client";

import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEMES, useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/components/ui";
import { Popover } from "@/components/ui/Popover";

const META: Record<Theme, { label: string; Icon: typeof Sun }> = {
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
  system: { label: "System", Icon: Monitor },
};

/** Compact header control picking the theme (light / dark / follow the OS). */
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const { Icon, label } = META[theme];
  // A <details> menu only closed by clicking its own summary again; every
  // header popover now shares Popover's outside-click/Escape behavior.
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Theme"
      autoFocus={false}
      panelClassName="w-36 space-y-0.5 p-1.5"
      className="group"
      trigger={
        <button
          type="button"
          aria-label={`Theme: ${label}`}
          aria-expanded={open}
          title="Theme"
          data-tour="theme-switcher"
          onClick={() => setOpen((o) => !o)}
          className="flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm font-medium text-fg transition-colors hover:border-border-strong"
        >
          <Icon className="h-4 w-4" aria-hidden />
          <span className={cn("text-[10px] text-faint transition-transform", open && "rotate-180")}>
            ▾
          </span>
        </button>
      }
    >
      {THEMES.map((t) => {
        const { label: itemLabel, Icon: ItemIcon } = META[t];
        return (
          <button
            key={t}
            type="button"
            aria-pressed={t === theme}
            onClick={() => {
              setTheme(t);
              setOpen(false);
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
    </Popover>
  );
}
