// Theme identity shared by the server layout (anti-flash script) and the
// client ThemeProvider. The palettes themselves live in app/globals.css — light
// is the :root token block, dark is [data-theme="dark"]. This module only owns
// which of the two is active.

/** What the user picked. "system" follows the OS `prefers-color-scheme`. */
export type Theme = "light" | "dark" | "system";

/** The palette actually painted — what lands in <html data-theme>. */
export type ResolvedTheme = "light" | "dark";

/** Menu order in the header switcher. */
export const THEMES: readonly Theme[] = ["light", "dark", "system"] as const;

export const THEME_STORAGE_KEY = "arima.theme";

export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Theme applied when the user has never chosen one. */
export const DEFAULT_THEME: Theme = "light";

/**
 * OS colour preference. Falls back to light where matchMedia is missing (old
 * webviews, non-browser environments) so the app never renders dark by accident.
 */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

/**
 * Inline <script> injected as the first child of <body> in app/layout.tsx so
 * the resolved theme lands on <html> before first paint (no flash on reload).
 * Static string — no user input. Must stay in sync with resolveTheme() +
 * applyTheme(): only "dark" and "system" can produce the dark palette; every
 * other stored value (including none, garbage, or blocked storage) is light.
 */
export const THEME_INIT_SCRIPT = `var t=null;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}var d=t==="dark"||(t==="system"&&typeof matchMedia==="function"&&matchMedia(${JSON.stringify(
  DARK_MEDIA_QUERY,
)}).matches);document.documentElement.dataset.theme=d?"dark":"light";`;
