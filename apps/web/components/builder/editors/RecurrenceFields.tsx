"use client";

/**
 * Recurrence + expiry controls, store-bound — shared by the Settings tab and
 * the arm-time activation sheet so both surfaces edit the same fields with
 * the same words.
 */
import { Segmented } from "@/components/ui";
import { useBuilderStore } from "@/lib/strategies/store";
import { Field, NumberInput } from "./fields";

export function RecurrenceFields() {
  const doc = useBuilderStore((s) => s.doc);
  const setRecurrence = useBuilderStore((s) => s.setRecurrence);
  return (
    <>
      <Field label="How often">
        <Segmented
          options={[
            { value: "once", label: "Trigger once" },
            { value: "repeat", label: "Repeat" },
          ]}
          value={doc.recurrence.kind}
          onChange={(v) =>
            setRecurrence(
              v === "once"
                ? { kind: "once" }
                : { kind: "repeat", maxRepeats: 5, cooldownMs: 600_000 },
            )
          }
          size="md"
          grow
        />
      </Field>
      {doc.recurrence.kind === "repeat" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max repeats">
            <NumberInput
              value={doc.recurrence.maxRepeats}
              onChange={(v) =>
                setRecurrence({
                  kind: "repeat",
                  maxRepeats: Math.max(2, Math.round(v)),
                  cooldownMs:
                    doc.recurrence.kind === "repeat" ? doc.recurrence.cooldownMs : 600_000,
                })
              }
              suffix="×"
              min={2}
              max={100}
            />
          </Field>
          <Field label="Cooldown">
            <NumberInput
              value={Math.round(
                (doc.recurrence.kind === "repeat" ? doc.recurrence.cooldownMs : 0) / 60_000,
              )}
              onChange={(v) =>
                setRecurrence({
                  kind: "repeat",
                  maxRepeats: doc.recurrence.kind === "repeat" ? doc.recurrence.maxRepeats : 5,
                  cooldownMs: Math.max(0, Math.round(v)) * 60_000,
                })
              }
              suffix="min"
              min={0}
              max={1440}
            />
          </Field>
        </div>
      ) : null}
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Coarse "stop watching after" control; exact timestamps stay canvas/API turf. */
export function ExpiryField() {
  const doc = useBuilderStore((s) => s.doc);
  const setExpiresAt = useBuilderStore((s) => s.setExpiresAt);
  const remainingDays = doc.expiresAtMs === null ? null : (doc.expiresAtMs - Date.now()) / DAY_MS;
  // Snap the stored timestamp back onto the nearest option for display.
  const value =
    remainingDays === null ? "never" : remainingDays <= 2 ? "1" : remainingDays <= 10 ? "7" : "30";
  return (
    <Field label="Stop watching after">
      <Segmented
        options={[
          { value: "never", label: "never" },
          { value: "1", label: "1 day" },
          { value: "7", label: "1 week" },
          { value: "30", label: "30 days" },
        ]}
        value={value}
        onChange={(v) => setExpiresAt(v === "never" ? null : Date.now() + Number(v) * DAY_MS)}
        size="md"
        grow
      />
    </Field>
  );
}
