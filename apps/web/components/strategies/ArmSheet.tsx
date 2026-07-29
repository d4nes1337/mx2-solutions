"use client";

/**
 * The arm-time activation sheet — the one moment the execution decision is
 * made: how the strategy fires (ask-me-to-sign vs auto via the Arima Wallet,
 * with its hard spend caps inline) and how the user is reached (browser
 * alerts, Telegram). Opens from the builder's save button; the Arm button
 * runs the EXISTING create/supersede path unchanged.
 *
 * Fail-safe by design: a remembered previous choice only prefills copy —
 * the sheet never silently switches a strategy to auto.
 */
import { useEffect } from "react";
import Link from "next/link";
import { ShieldCheck, Sparkles } from "lucide-react";
import { Button, Segmented } from "@/components/ui";
import { SheetPanel } from "@/components/ui/SheetPanel";
import { useBuilderStore } from "@/lib/strategies/store";
import { strategySentence, suggestStrategyName } from "@/lib/strategies/sentence";
import { loadLimitPrefs } from "@/lib/strategies/limit-prefs";
import type { AutoReadiness } from "@/lib/strategies/queries";
import { Field, NumberInput } from "@/components/builder/editors/fields";
import { ExpiryField, RecurrenceFields } from "@/components/builder/editors/RecurrenceFields";
import { RollingOutcomes } from "@/components/strategies/RollingOutcomes";
import { NotificationControls } from "@/components/action-center/NotificationControls";

const ARM_PREFS_KEY = "arima.strategies.arm-prefs.v1";

interface ArmPrefs {
  seen: boolean;
}

const loadArmPrefs = (): ArmPrefs => {
  try {
    const raw = localStorage.getItem(ARM_PREFS_KEY);
    return raw ? (JSON.parse(raw) as ArmPrefs) : { seen: false };
  } catch {
    return { seen: false };
  }
};

export const markArmSheetSeen = (): void => {
  try {
    localStorage.setItem(ARM_PREFS_KEY, JSON.stringify({ seen: true } satisfies ArmPrefs));
  } catch {
    // best-effort
  }
};

const DEFAULT_LIMITS_FROM_ORDER = (price: number, size: number) => {
  const notional = Math.max(10, Math.ceil((price * size) / 10) * 10);
  return {
    maxNotionalPerOrder: notional,
    maxDailyNotional: notional * 2,
    maxTotalNotional: notional * 4,
  };
};

export function ArmSheet({
  open,
  onClose,
  onArm,
  arming,
  saveError,
  autoReadiness,
}: {
  open: boolean;
  onClose: () => void;
  /** Runs the existing create/supersede mutation. */
  onArm: () => void;
  arming: boolean;
  saveError: string | null;
  autoReadiness: AutoReadiness | undefined;
}) {
  const doc = useBuilderStore((s) => s.doc);
  const setAction = useBuilderStore((s) => s.setAction);
  const setLimits = useBuilderStore((s) => s.setLimits);
  const setName = useBuilderStore((s) => s.setName);
  const suggestion = suggestStrategyName(doc);

  // First-time explanation collapses on later arms.
  const seenBefore = open ? loadArmPrefs().seen : false;
  useEffect(() => {
    if (open) markArmSheetSeen();
  }, [open]);

  const order = doc.action.kind === "order" ? doc.action : null;
  const auto = order?.execution === "auto";
  const blockers = autoReadiness?.blockers ?? [];

  const switchExecution = (execution: "prepare" | "auto") => {
    if (!order || order.execution === execution) return;
    setAction({ ...order, execution });
    if (execution === "auto" && doc.limits === null) {
      setLimits(loadLimitPrefs() ?? DEFAULT_LIMITS_FROM_ORDER(order.price, order.size));
    }
  };

  const armFooter = (
    <div className="space-y-2">
      <Button
        className="w-full"
        disabled={arming}
        onClick={() => {
          if (doc.name.trim() === "" && suggestion !== "") setName(suggestion);
          onArm();
        }}
      >
        <Sparkles size={14} aria-hidden />
        {arming ? "Arming…" : "Arm — start watching"}
      </Button>
      <p className="flex items-center gap-1.5 text-[11px] leading-snug text-muted">
        <ShieldCheck size={12} className="shrink-0 text-pos" aria-hidden />
        {auto
          ? "Auto trades only within the caps you set — everything else waits for your signature."
          : "Nothing trades without your signature. Arming just starts watching — nothing is bought until you approve it."}
      </p>
      {saveError ? <p className="text-[12px] text-neg">{saveError}</p> : null}
    </div>
  );

  return (
    <SheetPanel
      open={open}
      onClose={onClose}
      title="Arm this strategy"
      footer={armFooter}
      bodyClassName="space-y-4"
    >
      <div className="space-y-4">
        <p className="text-[12px] leading-relaxed text-muted">{strategySentence(doc)}</p>

        {/* Asked, never required: arming with this blank adopts the suggestion,
            so the list never fills up with indistinguishable rows. */}
        <Field label="Name it (optional)">
          <input
            value={doc.name}
            onChange={(e) => setName(e.target.value.slice(0, 120))}
            placeholder={suggestion || "Name your strategy…"}
            aria-label="Strategy name"
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none transition-colors placeholder:text-faint focus:border-brand"
          />
        </Field>

        {order ? (
          <div className="space-y-2">
            <Field label="How should this fire?">
              <Segmented
                options={[
                  { value: "prepare", label: "Ask me to sign" },
                  { value: "auto", label: "Auto · Arima Wallet" },
                ]}
                value={order.execution}
                onChange={(v) => switchExecution(v as "prepare" | "auto")}
                size="md"
                grow
              />
            </Field>
            {!auto && !seenBefore ? (
              <p className="text-[11px] leading-snug text-muted">
                When the conditions hold, the order is prepared and waits for your signature —
                in-app, or from a Telegram sign link.
              </p>
            ) : null}
            {auto ? (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Max per order">
                    <NumberInput
                      value={doc.limits?.maxNotionalPerOrder ?? 0}
                      onChange={(v) =>
                        setLimits({
                          maxNotionalPerOrder: Math.max(1, Math.round(v)),
                          maxDailyNotional: doc.limits?.maxDailyNotional ?? Math.round(v) * 2,
                          maxTotalNotional: doc.limits?.maxTotalNotional ?? Math.round(v) * 4,
                        })
                      }
                      suffix="$"
                      min={1}
                    />
                  </Field>
                  <Field label="Max per day">
                    <NumberInput
                      value={doc.limits?.maxDailyNotional ?? 0}
                      onChange={(v) =>
                        setLimits({
                          maxNotionalPerOrder: doc.limits?.maxNotionalPerOrder ?? 10,
                          maxDailyNotional: Math.max(1, Math.round(v)),
                          maxTotalNotional: doc.limits?.maxTotalNotional ?? Math.round(v) * 2,
                        })
                      }
                      suffix="$"
                      min={1}
                    />
                  </Field>
                  <Field label="Max total">
                    <NumberInput
                      value={doc.limits?.maxTotalNotional ?? 0}
                      onChange={(v) =>
                        setLimits({
                          maxNotionalPerOrder: doc.limits?.maxNotionalPerOrder ?? 10,
                          maxDailyNotional: doc.limits?.maxDailyNotional ?? Math.round(v),
                          maxTotalNotional: Math.max(1, Math.round(v)),
                        })
                      }
                      suffix="$"
                      min={1}
                    />
                  </Field>
                </div>
                {blockers.length > 0 ? (
                  <div className="rounded-md border border-warn/30 bg-warn/10 p-2 text-[11px] leading-snug text-warn">
                    <p className="font-medium">
                      Auto mode can&apos;t execute unattended yet — triggers will wait for your
                      confirmation:
                    </p>
                    <ul className="mt-1 list-disc pl-4">
                      {blockers.slice(0, 3).map((b) => (
                        <li key={b.code}>{b.detail}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-[11px] leading-snug text-muted">
                    Auto mode places orders from your{" "}
                    <Link href="/wallet" className="text-accent hover:underline">
                      Arima trading wallet
                    </Link>{" "}
                    only within the caps above.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <RecurrenceFields />
          <ExpiryField />
        </div>

        {/* Rolling strategies fire once per window, so the honest question is
            not "what could this make" but "how often must it be right". */}
        {order?.rollingSeries ? (
          <RollingOutcomes
            action={order}
            windows={doc.recurrence.kind === "repeat" ? doc.recurrence.maxRepeats : 1}
          />
        ) : null}

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">
            How should we reach you?
          </p>
          <NotificationControls />
        </div>
      </div>
    </SheetPanel>
  );
}
