/**
 * Last-used auto-mode spending limits, persisted locally so switching a new
 * strategy to Auto starts from the caps the user already chose once instead of
 * a blank three-field form. Prefill only — limits stay REQUIRED for auto and
 * are fully validated client- and server-side (security invariant W5).
 */
import type { StrategyLimits } from "@mx2/rules";

const KEY = "arima.smart-orders.limits.v1";

export const loadLimitPrefs = (): StrategyLimits | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StrategyLimits>;
    const { maxNotionalPerOrder, maxDailyNotional, maxTotalNotional } = parsed;
    if (
      typeof maxNotionalPerOrder !== "number" ||
      typeof maxDailyNotional !== "number" ||
      typeof maxTotalNotional !== "number" ||
      !(maxNotionalPerOrder > 0 && maxDailyNotional > 0 && maxTotalNotional > 0)
    ) {
      return null;
    }
    return { maxNotionalPerOrder, maxDailyNotional, maxTotalNotional };
  } catch {
    return null;
  }
};

export const saveLimitPrefs = (limits: StrategyLimits | null): void => {
  if (typeof window === "undefined" || limits === null) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(limits));
  } catch {
    // storage blocked/full — prefill is best-effort
  }
};
