import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ThemeProvider, THEME_STORAGE_KEY } from "@/lib/theme";
import { DARK_MEDIA_QUERY } from "@/lib/theme-constants";
import { ThemeSwitcher } from "./ThemeSwitcher";

/**
 * The switcher is a real popover now (outside-click/Escape closable) rather
 * than a <details>, so its options only exist in the DOM while it is open.
 */
function renderSwitcher() {
  const result = render(
    <ThemeProvider>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^theme:/i }));
  return result;
}

/** Re-open after a pick — choosing an option closes the menu. */
function reopen() {
  fireEvent.click(screen.getByRole("button", { name: /^theme:/i }));
}

/**
 * Scope option lookups to the open panel: the trigger carries the current
 * theme in its own label ("Theme: Dark"), so a bare byRole is ambiguous.
 */
function option(name: RegExp) {
  return within(screen.getByRole("dialog", { name: "Theme" })).getByRole("button", { name });
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
    fireEvent.click(option(/dark/i));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("switching back to light writes the light attribute", () => {
    renderSwitcher();
    fireEvent.click(option(/dark/i));
    expect(document.documentElement.dataset.theme).toBe("dark");
    reopen();
    fireEvent.click(option(/light/i));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("restores the stored theme on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderSwitcher();
    // The provider reads storage in an effect; the current theme is marked pressed.
    expect(option(/dark/i)).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores garbage stored values (falls back to the light default)", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "paper");
    renderSwitcher();
    expect(option(/light/i)).toHaveAttribute("aria-pressed", "true");
  });

  it("defaults to light when nothing is stored", () => {
    renderSwitcher();
    expect(option(/light/i)).toHaveAttribute("aria-pressed", "true");
  });

  it("persists system as the preference and resolves it to the OS palette", () => {
    stubSystemDark(true);
    renderSwitcher();
    fireEvent.click(option(/system/i));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    reopen();
    expect(option(/system/i)).toHaveAttribute("aria-pressed", "true");
  });

  // The <details> version could only be closed by clicking its own summary:
  // menus were left hanging over the page after the user moved on.
  it("closes on an outside click and on Escape", () => {
    renderSwitcher();
    expect(screen.getByRole("dialog", { name: "Theme" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Theme" })).not.toBeInTheDocument();

    reopen();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Theme" })).not.toBeInTheDocument();
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
    fireEvent.click(option(/light/i));
    system.flip(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
