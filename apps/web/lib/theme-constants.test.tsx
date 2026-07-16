import { afterEach, describe, expect, it } from "vitest";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "./theme-constants";

// The anti-flash script runs as a raw inline <body> script — exercise it the
// same way (indirect eval in jsdom) for each storage state.
function runInitScript() {
  window.eval(THEME_INIT_SCRIPT);
}

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("THEME_INIT_SCRIPT", () => {
  it("applies paper when nothing is stored", () => {
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("paper");
  });

  it("keeps an explicitly stored light attribute-free", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("applies a stored dark theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("applies a stored paper theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "paper");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("paper");
  });

  it("treats garbage values as the paper default", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe("paper");
  });
});
