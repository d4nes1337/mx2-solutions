import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AmountSlider } from "./AmountSlider";

describe("AmountSlider", () => {
  it("renders the slider when a max balance is known", () => {
    render(<AmountSlider value="" onChange={() => {}} maxAmount={100} unitLabel="USD" />);
    expect(screen.getByRole("slider")).toBeTruthy();
    expect(screen.getByRole("spinbutton")).toBeTruthy(); // the numeric input
  });

  it("degrades to input-only when the max is unknown", () => {
    render(<AmountSlider value="" onChange={() => {}} maxAmount={null} />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByRole("spinbutton")).toBeTruthy();
  });

  it("emits the raw string when the user types", () => {
    const onChange = vi.fn();
    render(<AmountSlider value="" onChange={onChange} maxAmount={100} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "42" } });
    expect(onChange).toHaveBeenCalledWith("42");
  });

  it("emits a floored amount when the slider moves", () => {
    const onChange = vi.fn();
    render(<AmountSlider value="0" onChange={onChange} maxAmount={10} decimals={2} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3.005" } });
    expect(onChange).toHaveBeenCalledWith("3"); // floorTo(3.005, 2) = 3
  });

  it("Max sets the floored maximum", () => {
    const onChange = vi.fn();
    render(<AmountSlider value="" onChange={onChange} maxAmount={1.23456} decimals={4} unitLabel="ETH" />);
    fireEvent.click(screen.getByRole("button", { name: /Max/ }));
    expect(onChange).toHaveBeenCalledWith("1.2345");
  });

  it("shows a live USD readout from the per-unit price", () => {
    render(
      <AmountSlider value="2" onChange={() => {}} maxAmount={5} usdPerUnit={3000} unitLabel="ETH" />,
    );
    expect(screen.getByText("≈ $6000.00")).toBeTruthy();
  });

  it("disables both controls when disabled", () => {
    render(<AmountSlider value="1" onChange={() => {}} maxAmount={10} disabled />);
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(true);
  });
});
