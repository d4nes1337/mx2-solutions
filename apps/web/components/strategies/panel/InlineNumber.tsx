"use client";

/**
 * Click-to-edit number for the strategy panel: renders as a dashed-underline
 * value, opens a small popover with a clamped NumberInput, and STAGES the new
 * value into the panel's edit state — nothing touches the server until the
 * panel's Apply bar runs the supersede flow.
 */
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button, cn } from "@/components/ui";
import { Popover } from "@/components/ui/Popover";
import { NumberInput } from "@/components/builder/editors/fields";

export function InlineNumber({
  label,
  display,
  value,
  min,
  max,
  step = 1,
  suffix,
  dirty = false,
  disabled = false,
  onCommit,
}: {
  /** What is being edited — dialog + aria name ("Trigger price"). */
  label: string;
  /** Formatted current (staged) value, e.g. "34¢" or "100 shares". */
  display: string;
  /** Staged numeric value in edit units (integer cents / shares). */
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** Staged value differs from the stored definition. */
  dirty?: boolean;
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  if (disabled) {
    return <span className="tabular text-[12px] text-muted">{display}</span>;
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={`Edit ${label.toLowerCase()}`}
      trigger={
        <button
          type="button"
          title={`Edit ${label.toLowerCase()}`}
          onClick={() => {
            setDraft(value);
            setOpen(!open);
          }}
          className={cn(
            "tabular inline-flex items-center gap-1 border-b border-dashed text-[12px] font-semibold transition-colors",
            dirty
              ? "border-brand text-accent"
              : "border-border-strong text-fg hover:border-brand hover:text-accent",
          )}
        >
          {display}
          <Pencil size={9} aria-hidden className="opacity-60" />
        </button>
      }
    >
      <div className="w-44 space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
        <NumberInput
          value={draft}
          onChange={setDraft}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          step={step}
          {...(suffix !== undefined ? { suffix } : {})}
        />
        <p className="text-[10px] leading-snug text-faint">Applies as a new version on save.</p>
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onCommit(draft);
              setOpen(false);
            }}
          >
            Set
          </Button>
        </div>
      </div>
    </Popover>
  );
}
