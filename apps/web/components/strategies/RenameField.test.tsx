import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const mutate = vi.fn();
vi.mock("@/lib/strategies/queries", () => ({
  useRenameStrategy: () => ({ mutate, isPending: false }),
}));

import { RenameField } from "./RenameField";

beforeEach(() => mutate.mockClear());

describe("RenameField", () => {
  it("shows the fallback when unnamed and commits a new name on Enter", () => {
    render(<RenameField id="s1" name={null} fallback="Buy Fed cuts" />);
    // Unnamed strategies still read as something, not a blank row.
    fireEvent.click(screen.getByText("Buy Fed cuts"));

    const input = screen.getByLabelText("Strategy name");
    fireEvent.change(input, { target: { value: "Fed hedge" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutate).toHaveBeenCalledWith({ id: "s1", name: "Fed hedge" });
  });

  it("Escape reverts without saving", () => {
    render(<RenameField id="s1" name="Original" fallback="fallback" />);
    fireEvent.click(screen.getByText("Original"));

    const input = screen.getByLabelText("Strategy name");
    fireEvent.change(input, { target: { value: "scrapped" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Original")).toBeInTheDocument();
  });

  it("does not fire a mutation when the name is unchanged", () => {
    render(<RenameField id="s1" name="Same" fallback="fallback" />);
    fireEvent.click(screen.getByText("Same"));
    fireEvent.blur(screen.getByLabelText("Strategy name"));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("an emptied name clears the override", () => {
    render(<RenameField id="s1" name="Old" fallback="fallback" />);
    fireEvent.click(screen.getByText("Old"));
    const input = screen.getByLabelText("Strategy name");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(mutate).toHaveBeenCalledWith({ id: "s1", name: "" });
  });

  it("the idle slot keeps the title's own primary action", () => {
    const onOpen = vi.fn();
    render(
      <RenameField
        id="s1"
        name="Named"
        fallback="fallback"
        idle={(startEditing) => (
          <>
            <button onClick={onOpen}>Named</button>
            <button aria-label="Rename strategy" onClick={startEditing} />
          </>
        )}
      />,
    );
    // Clicking the title does NOT start a rename…
    fireEvent.click(screen.getByText("Named"));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.queryByLabelText("Strategy name")).toBeNull();
    // …only the dedicated trigger does.
    fireEvent.click(screen.getByLabelText("Rename strategy"));
    expect(screen.getByLabelText("Strategy name")).toBeInTheDocument();
  });
});
