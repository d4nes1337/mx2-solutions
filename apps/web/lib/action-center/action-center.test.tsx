import { beforeEach, describe, expect, it } from "vitest";
import { isHandled, markHandled } from "./cross-tab";
import { setTabBadge, restoreTab } from "./tab-badge";
import { useNotificationPrefs, readNotificationPrefs } from "@/lib/notification-prefs";

beforeEach(() => {
  window.localStorage.clear();
  document.title = "Test Route";
});

describe("cross-tab handled ids", () => {
  it("marks a trigger handled once, deduping across polls", () => {
    expect(isHandled("trig-A")).toBe(false);
    markHandled("trig-A");
    expect(isHandled("trig-A")).toBe(true);
    // An unrelated id is unaffected.
    expect(isHandled("trig-B")).toBe(false);
  });

  it("prunes handled ids older than the TTL", () => {
    // Seed an ancient entry directly, then a read prunes it.
    window.localStorage.setItem(
      "arima.action-center.handled.v1",
      JSON.stringify({ old: Date.now() - 48 * 60 * 60 * 1000, fresh: Date.now() }),
    );
    expect(isHandled("old")).toBe(false);
    expect(isHandled("fresh")).toBe(true);
  });
});

describe("tab badge", () => {
  it("badges the title with the ready count and restores at zero", () => {
    setTabBadge(2);
    expect(document.title).toBe("(2) Ready to sign · Arima");
    setTabBadge(0);
    expect(document.title).toBe("Test Route");
  });

  it("caps the displayed count at 9+ and restores explicitly", () => {
    setTabBadge(12);
    expect(document.title).toBe("(9+) Ready to sign · Arima");
    restoreTab();
    expect(document.title).toBe("Test Route");
  });
});

describe("notification prefs", () => {
  it("defaults to alerts-off and persists changes to localStorage", () => {
    // Fresh store snapshot: browser alerts start OFF (never on by default).
    useNotificationPrefs.getState().set({ browserAlerts: false, sound: true });
    expect(readNotificationPrefs().browserAlerts).toBe(false);

    useNotificationPrefs.getState().set({ browserAlerts: true, sound: false });
    expect(readNotificationPrefs().browserAlerts).toBe(true);
    expect(readNotificationPrefs().sound).toBe(false);
    const raw = JSON.parse(window.localStorage.getItem("arima.action-center.prefs.v1") ?? "{}");
    expect(raw.browserAlerts).toBe(true);
    expect(raw.sound).toBe(false);
  });
});
