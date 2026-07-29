/**
 * Pending referral code, persisted across the connect→sign round-trip so a
 * /r/CODE visitor never types anything: the code rides along automatically on
 * the next sign-in attempt and is cleared once a session exists.
 */
const KEY = "arima.refCode";

/** Mirrors the server's canonical form (uppercase, 3–20 alphanumerics). */
const CODE_RE = /^[A-Z0-9]{3,20}$/;

export function normalizeRefCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function storeRefCode(input: string): string | null {
  const code = normalizeRefCode(input);
  if (!code || typeof window === "undefined") return null;
  try {
    window.localStorage.setItem(KEY, code);
  } catch {
    // Private-mode storage failures degrade to manual code entry.
  }
  return code;
}

export function getStoredRefCode(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? normalizeRefCode(raw) : null;
  } catch {
    return null;
  }
}

export function clearStoredRefCode(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
