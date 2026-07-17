import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("Markdown blocks", () => {
  it("splits blank-line-separated paragraphs", () => {
    const { container } = render(<Markdown text={"first para\n\nsecond para"} />);
    const ps = container.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0]!.textContent).toBe("first para");
    expect(ps[1]!.textContent).toBe("second para");
  });

  it("turns single newlines inside a paragraph into <br/>", () => {
    const { container } = render(<Markdown text={"line one\nline two"} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(container.textContent).toBe("line oneline two");
  });

  it("renders ordered lists for 1. and 2) markers", () => {
    const { container } = render(<Markdown text={"1. first\n2) second"} />);
    const ol = container.querySelector("ol");
    expect(ol).not.toBeNull();
    expect(ol!.className).toContain("list-decimal");
    const items = ol!.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe("first");
    expect(items[1]!.textContent).toBe("second");
  });

  it("renders bulleted lists for -, * and • markers", () => {
    const { container } = render(<Markdown text={"- dash\n* star\n• dot"} />);
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    expect(ul!.className).toContain("list-disc");
    const items = ul!.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[2]!.textContent).toBe("dot");
  });

  it("keeps a mixed-marker block as a paragraph", () => {
    const { container } = render(<Markdown text={"- bullet\nplain line"} />);
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("passes className through to the root", () => {
    const { container } = render(<Markdown text="hi" className="text-xs" />);
    expect((container.firstChild as HTMLElement).className).toContain("text-xs");
  });
});

describe("Markdown inline", () => {
  it("renders **bold** as <strong>", () => {
    const { container } = render(<Markdown text="a **bold** b" />);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("bold");
  });

  it("renders *italic* and _italic_ as <em>", () => {
    const { container } = render(<Markdown text="*one* and _two_" />);
    const ems = container.querySelectorAll("em");
    expect(ems).toHaveLength(2);
    expect(ems[0]!.textContent).toBe("one");
    expect(ems[1]!.textContent).toBe("two");
  });

  it("renders `code` with the mono chip styling", () => {
    const { container } = render(<Markdown text="run `pnpm test` now" />);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("pnpm test");
    expect(code!.className).toContain("bg-surface-3");
    expect(code!.className).toContain("font-mono");
  });

  it("code wins over other markers — no nesting inside", () => {
    const { container } = render(<Markdown text={"`**not bold**`"} />);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("code")!.textContent).toBe("**not bold**");
  });

  it("supports italic and code nested inside bold", () => {
    const { container } = render(<Markdown text={"**bold *it* and `c`**"} />);
    const strong = container.querySelector("strong")!;
    expect(strong.querySelector("em")!.textContent).toBe("it");
    expect(strong.querySelector("code")!.textContent).toBe("c");
  });

  it("renders inline markup inside list items", () => {
    const { container } = render(<Markdown text={"- buy **YES** at `40¢`"} />);
    const li = container.querySelector("li")!;
    expect(li.querySelector("strong")!.textContent).toBe("YES");
    expect(li.querySelector("code")!.textContent).toBe("40¢");
  });

  it("leaves unclosed markers literal", () => {
    const { container } = render(<Markdown text="a ** b ` c * d" />);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toBe("a ** b ` c * d");
  });

  it("does not italicize spaced asterisks or snake_case", () => {
    const { container } = render(<Markdown text="2 * 3 * 4 and snake_case_name" />);
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("2 * 3 * 4 and snake_case_name");
  });
});

describe("Markdown XSS safety", () => {
  it("renders raw HTML as literal visible text, never as elements", () => {
    const { container } = render(<Markdown text={"<script>alert(1)</script>"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBe("<script>alert(1)</script>");
  });

  it("renders HTML mixed with markdown as text", () => {
    const { container } = render(<Markdown text={'**bold** <img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
