import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider, THEME_STORAGE_KEY } from "@/lib/theme";
import { DARK_MEDIA_QUERY } from "@/lib/theme-constants";
import { ThemeSwitcher } from "./ThemeSwitcher";

function renderSwitcher() {
  return render(
    <ThemeProvider>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
}

/**
 * jsdom reports no colour-scheme preference — stand in a query whose `matches`
 * we control and whose change listeners we can fire.
 */
function stubSystemDark(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return prefersDark;
    },
    media: DARK_MEDIA_QUERY,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.spyOn(window, "matchMedia").mockImplementation(() => query as unknown as MediaQueryList);
  return {
    flip(next: boolean) {
      prefersDark = next;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("ThemeSwitcher", () => {
  it("applies a chosen theme to <html> and persists it", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /dark/i }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("switching back to light writes the light attribute", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /dark/i }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /light/i }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("restores the stored theme on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderSwitcher();
    // The provider reads storage in an effect; the current theme is marked pressed.
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores garbage stored values (falls back to the light default)", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "paper");
    renderSwitcher();
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("defaults to light when nothing is stored", () => {
    renderSwitcher();
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("persists system as the preference and resolves it to the OS palette", () => {
    stubSystemDark(true);
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /system/i }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: /system/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows the OS flipping schemes while the preference is system", () => {
    const system = stubSystemDark(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    renderSwitcher();
    expect(document.documentElement.dataset.theme).toBe("light");
    system.flip(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("stops following the OS once an explicit theme is chosen", () => {
    const system = stubSystemDark(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /light/i }));
    system.flip(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
