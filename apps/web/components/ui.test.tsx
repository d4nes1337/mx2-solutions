import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Segmented } from "./ui";
import { NumberInput } from "./builder/editors/fields";

afterEach(cleanup);

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

describe("Segmented", () => {
  it("defaults to the compact inline layout", () => {
    const { container } = render(<Segmented options={OPTIONS} value="a" onChange={() => {}} />);
    expect((container.firstChild as HTMLElement).className).toContain("inline-flex");
  });

  it("grow renders an equal-width grid with truncating segments", () => {
    const { container } = render(
      <Segmented options={OPTIONS} value="a" onChange={() => {}} grow />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("grid");
    expect(root.className).toContain("w-full");
    const button = screen.getByRole("button", { name: "Alpha" });
    expect(button.className).toContain("truncate");
  });
});

describe("NumberInput", () => {
  it("never commits a cleared or unparsable value", () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    // The field may look empty mid-edit, but blur re-syncs to the last value.
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("5");
  });

  it("clamps typed values to min/max on commit", () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} min={2} max={100} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "500" } });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.change(input, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith(2);
    for (const call of onChange.mock.calls) expect(Number.isFinite(call[0])).toBe(true);
  });
});
