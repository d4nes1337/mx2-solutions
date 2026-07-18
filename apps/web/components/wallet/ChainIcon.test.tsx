import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChainIcon } from "./ChainIcon";

describe("ChainIcon", () => {
  it("renders a labelled badge for a known chain", () => {
    const { getByRole } = render(<ChainIcon chainId="137" name="Polygon" />);
    const svg = getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe("Polygon logo");
    // Branded circle background is always present.
    expect(svg.querySelector("circle")).not.toBeNull();
  });

  it("falls back to the first letter of the name for an unknown chain", () => {
    const { getByRole } = render(<ChainIcon chainId="999999" name="Zephyr" />);
    const svg = getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe("Zephyr logo");
    expect(svg.textContent).toContain("Z");
  });

  it("respects the size prop", () => {
    const { getByRole } = render(<ChainIcon chainId="1" name="Ethereum" size={28} />);
    expect(getByRole("img").getAttribute("width")).toBe("28");
  });
});
