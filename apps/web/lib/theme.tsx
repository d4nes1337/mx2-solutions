"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_THEME, THEME_STORAGE_KEY, isTheme, type Theme } from "./theme-constants";

export { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY, isTheme, type Theme } from "./theme-constants";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "light") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Server render assumes the default (paper); an explicit stored choice is
  // read after mount. The DOM attribute is already correct pre-paint via
  // THEME_INIT_SCRIPT, so this delay only affects JS consumers (e.g. the
  // RainbowKit theme object).
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (isTheme(stored)) setThemeState(stored);
    } catch {
      // localStorage unavailable (e.g. blocked) — stay on the default.
    }
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setTheme(next: Theme) {
        setThemeState(next);
        applyTheme(next);
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // Non-persistent is fine; the in-page switch still applies.
        }
      },
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
