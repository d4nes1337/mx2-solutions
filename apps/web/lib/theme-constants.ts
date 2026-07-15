// Theme identity shared by the server layout (anti-flash script) and the
// client ThemeProvider. The palettes themselves live in app/globals.css as
// [data-theme] token blocks — this module only owns which theme is active.

export type Theme = "light" | "paper" | "dark";

export const THEMES: readonly Theme[] = ["light", "paper", "dark"] as const;

export const THEME_STORAGE_KEY = "arima.theme";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * Inline <script> injected as the first child of <body> in app/layout.tsx so
 * the stored theme lands on <html> before first paint (no flash on reload).
 * Static string — no user input. Must stay in sync with applyTheme().
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="dark"||t==="paper")document.documentElement.dataset.theme=t}catch(e){}`;
