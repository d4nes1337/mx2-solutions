import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STORAGE_KEY,
  usePanelWidth,
} from "./use-panel-width";

afterEach(() => window.localStorage.clear());

const keyEvent = (key: string, shiftKey = false) =>
  ({ key, shiftKey, preventDefault: () => {} }) as unknown as React.KeyboardEvent<HTMLElement>;

describe("usePanelWidth", () => {
  it("starts at the default and restores a stored width", () => {
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, "500");
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(500);
  });

  it("clamps a stored out-of-range width", () => {
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, "9999");
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(PANEL_WIDTH_MAX);
  });

  it("ignores garbage storage", () => {
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, "wide");
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(PANEL_WIDTH_DEFAULT);
  });

  it("arrow keys resize within bounds and persist", () => {
    const { result } = renderHook(() => usePanelWidth());
    act(() => result.current.onKeyDown(keyEvent("ArrowLeft")));
    expect(result.current.width).toBe(PANEL_WIDTH_DEFAULT + 16);
    expect(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe(
      String(PANEL_WIDTH_DEFAULT + 16),
    );
    act(() => result.current.onKeyDown(keyEvent("End")));
    expect(result.current.width).toBe(PANEL_WIDTH_MIN);
    act(() => result.current.onKeyDown(keyEvent("ArrowRight")));
    expect(result.current.width).toBe(PANEL_WIDTH_MIN); // already at the floor
    act(() => result.current.onKeyDown(keyEvent("Home")));
    expect(result.current.width).toBe(PANEL_WIDTH_MAX);
  });
});
