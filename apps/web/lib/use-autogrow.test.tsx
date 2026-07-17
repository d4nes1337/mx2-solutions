import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutogrowTextarea } from "./use-autogrow";

/** jsdom has no layout, so scrollHeight is mocked with a mutable getter. */
function makeTextarea(scrollHeight: number) {
  const el = document.createElement("textarea");
  let h = scrollHeight;
  Object.defineProperty(el, "scrollHeight", { get: () => h, configurable: true });
  return { el, ref: { current: el }, setScrollHeight: (v: number) => (h = v) };
}

describe("useAutogrowTextarea", () => {
  it("sets height to scrollHeight within the default bounds", () => {
    const { el, ref } = makeTextarea(80);
    renderHook(({ value }) => useAutogrowTextarea(ref, value), {
      initialProps: { value: "hello" },
    });
    expect(el.style.height).toBe("80px");
    expect(el.style.overflowY).toBe("hidden");
  });

  it("clamps to minPx for tiny content", () => {
    const { el, ref } = makeTextarea(10);
    renderHook(({ value }) => useAutogrowTextarea(ref, value), {
      initialProps: { value: "" },
    });
    expect(el.style.height).toBe("52px");
  });

  it("caps at maxPx and enables internal scrolling past the cap", () => {
    const { el, ref, setScrollHeight } = makeTextarea(80);
    const { rerender } = renderHook(({ value }) => useAutogrowTextarea(ref, value), {
      initialProps: { value: "short" },
    });
    setScrollHeight(400);
    rerender({ value: "short\nplus\nmany\nmore\nlines" });
    expect(el.style.height).toBe("160px");
    expect(el.style.overflowY).toBe("auto");
  });

  it("shrinks back when content shrinks", () => {
    const { el, ref, setScrollHeight } = makeTextarea(400);
    const { rerender } = renderHook(({ value }) => useAutogrowTextarea(ref, value), {
      initialProps: { value: "long" },
    });
    expect(el.style.height).toBe("160px");
    setScrollHeight(60);
    rerender({ value: "x" });
    expect(el.style.height).toBe("60px");
    expect(el.style.overflowY).toBe("hidden");
  });

  it("honors custom minPx/maxPx", () => {
    const { el, ref } = makeTextarea(500);
    renderHook(({ value }) => useAutogrowTextarea(ref, value, { minPx: 40, maxPx: 220 }), {
      initialProps: { value: "v" },
    });
    expect(el.style.height).toBe("220px");
  });

  it("is a no-op with a null ref", () => {
    const ref = { current: null };
    expect(() =>
      renderHook(({ value }) => useAutogrowTextarea(ref, value), {
        initialProps: { value: "v" },
      }),
    ).not.toThrow();
  });
});
