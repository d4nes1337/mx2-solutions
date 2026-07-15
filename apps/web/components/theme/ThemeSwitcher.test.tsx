import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider, THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeSwitcher } from "./ThemeSwitcher";

function renderSwitcher() {
  return render(
    <ThemeProvider>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
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

  it("switching back to light removes the attribute", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /paper/i }));
    expect(document.documentElement.dataset.theme).toBe("paper");
    fireEvent.click(screen.getByRole("button", { name: /light/i }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("restores the stored theme on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "paper");
    renderSwitcher();
    // The provider reads storage in an effect; the current theme is marked pressed.
    expect(screen.getByRole("button", { name: /paper/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores garbage stored values", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    renderSwitcher();
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
  });
});
