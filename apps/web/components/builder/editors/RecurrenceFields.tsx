"use client";

/**
 * Recurrence + expiry controls, store-bound — shared by the Settings tab and
 * the arm-time activation sheet so both surfaces edit the same fields with
 * the same words. Every duration offers presets AND a custom value: presets
 * are a shortcut, never a cage.
 */
import { Segmented } from "@/components/ui";
import { useBuilderStore } from "@/lib/strategies/store";
import { Field, NumberInput } from "./fields";
import { DurationField } from "./DurationField";

const COOLDOWN_PRESETS = [
  { value: 0, label: "none" },
  { value: 300_000, label: "5m" },
  { value: 600_000, label: "10m" },
  { value: 3_600_000, label: "1h" },
];

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
        <div className="space-y-2">
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
          <Field label="Cooldown between triggers">
            <DurationField
              value={doc.recurrence.kind === "repeat" ? doc.recurrence.cooldownMs : 600_000}
              onChange={(ms) =>
                setRecurrence({
                  kind: "repeat",
                  maxRepeats: doc.recurrence.kind === "repeat" ? doc.recurrence.maxRepeats : 5,
                  cooldownMs: ms,
                })
              }
              presets={COOLDOWN_PRESETS}
              units={["seconds", "minutes", "hours"]}
              max={86_400_000}
            />
          </Field>
        </div>
      ) : null}
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_PRESETS = [
  { value: 1 * DAY_MS, label: "1 day" },
  { value: 7 * DAY_MS, label: "1 week" },
  { value: 30 * DAY_MS, label: "30 days" },
];

/**
 * "Stop watching after" — a RELATIVE window the user picks, stored as an
 * absolute timestamp. "Never" is a distinct state (null), so it sits outside
 * the duration control rather than pretending to be a zero duration.
 */
export function ExpiryField() {
  const doc = useBuilderStore((s) => s.doc);
  const setExpiresAt = useBuilderStore((s) => s.setExpiresAt);
  const never = doc.expiresAtMs === null;
  // Remaining time, rounded to whole minutes so a stored timestamp still
  // matches the preset it was created from instead of drifting to Custom.
  const remainingMs = never
    ? 7 * DAY_MS
    : Math.max(60_000, Math.round((doc.expiresAtMs! - Date.now()) / 60_000) * 60_000);
  const snapped = EXPIRY_PRESETS.find((p) => Math.abs(p.value - remainingMs) < 60_000);

  // Instant-market default: binding a recurring window tightens the expiry to
  // the window end (store.ts) — say so, or the auto-set value looks like a bug.
  const windowMatched =
    !never &&
    Object.values(doc.marketMeta).some((meta) => {
      if (!meta.recurrence || !meta.endDate) return false;
      const endMs = Date.parse(meta.endDate);
      return Number.isFinite(endMs) && Math.abs(endMs - doc.expiresAtMs!) < 60_000;
    });

  return (
    <Field label="Stop watching after">
      <div className="space-y-1.5">
        <Segmented
          options={[
            { value: "never", label: "Never expires" },
            { value: "after", label: "After a while" },
          ]}
          value={never ? "never" : "after"}
          onChange={(v) =>
            setExpiresAt(v === "never" ? null : Date.now() + (snapped?.value ?? 7 * DAY_MS))
          }
          size="md"
          grow
        />
        {never ? null : (
          <DurationField
            value={snapped?.value ?? remainingMs}
            onChange={(ms) => setExpiresAt(Date.now() + ms)}
            presets={EXPIRY_PRESETS}
            units={["hours", "days"]}
            max={365 * DAY_MS}
          />
        )}
        {windowMatched ? (
          <p className="text-[11px] text-muted">
            Set to the market’s window end — this strategy stops with its instant market.
          </p>
        ) : null}
      </div>
    </Field>
  );
}
