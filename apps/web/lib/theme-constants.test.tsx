import { afterEach, describe, expect, it, vi } from "vitest";
import { DARK_MEDIA_QUERY, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "./theme-constants";

// The anti-flash script runs as a raw inline <body> script — exercise it the
// same way (indirect eval in jsdom) for each storage state.
function runInitScript() {
  window.eval(THEME_INIT_SCRIPT);
}

/** jsdom has no colour-scheme preference — stub the query the script reads. */
function stubSystemDark(prefersDark: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === DARK_MEDIA_QUERY && prefersDark,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("THEME_INIT_SCRIPT", () => {
  it("applies light when nothing is stored", () => {
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applies a stored light theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applies a stored dark theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves a stored system theme to dark when the OS prefers dark", () => {
    stubSystemDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves a stored system theme to light when the OS prefers light", () => {
    stubSystemDark(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("treats garbage values as the light default", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "paper");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
