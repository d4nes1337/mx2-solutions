"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isTheme,
  resolveTheme,
  type ResolvedTheme,
  type Theme,
} from "./theme-constants";

export {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  isTheme,
  resolveTheme,
  systemTheme,
  type ResolvedTheme,
  type Theme,
} from "./theme-constants";

export function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved;
}

type ThemeContextValue = {
  /** The stored preference — may be "system". */
  theme: Theme;
  /** The palette currently painted. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  resolvedTheme: resolveTheme(DEFAULT_THEME),
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Server render assumes the default (light); an explicit stored choice is
  // read after mount. The DOM attribute is already correct pre-paint via
  // THEME_INIT_SCRIPT, so this delay only affects JS consumers (e.g. the
  // RainbowKit theme object).
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(resolveTheme(DEFAULT_THEME));

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // localStorage unavailable (e.g. blocked) — stay on the default.
    }
    const next = isTheme(stored) ? stored : DEFAULT_THEME;
    setThemeState(next);
    setResolvedTheme(resolveTheme(next));
  }, []);

  // While the preference is "system", track the OS flipping between schemes.
  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_MEDIA_QUERY);
    const sync = () => {
      const next: ResolvedTheme = query.matches ? "dark" : "light";
      setResolvedTheme(next);
      applyTheme(next);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    const resolved = resolveTheme(next);
    setThemeState(next);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Non-persistent is fine; the in-page switch still applies.
    }
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
