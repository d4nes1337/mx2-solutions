import { describe, expect, it } from "vitest";
import { parseJsonArray, pct, shortAddress, signed, toNum, usdCompact } from "./format";

describe("format helpers", () => {
  it("parseJsonArray handles valid, empty and malformed input", () => {
    expect(parseJsonArray('["Yes","No"]')).toEqual(["Yes", "No"]);
    expect(parseJsonArray("")).toEqual([]);
    expect(parseJsonArray("not json")).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
  });

  it("toNum coerces strings and guards NaN", () => {
    expect(toNum("1.5")).toBe(1.5);
    expect(toNum(2)).toBe(2);
    expect(toNum("nope")).toBe(0);
    expect(toNum(undefined)).toBe(0);
  });

  it("pct renders a 0-1 probability as a percent", () => {
    expect(pct("0.5")).toBe("50.0%");
    expect(pct(0.123)).toBe("12.3%");
  });

  it("signed prefixes positive numbers with +", () => {
    expect(signed(5)).toBe("+5.00");
    expect(signed(-3)).toBe("-3.00");
  });

  it("shortAddress truncates the middle", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortAddress("")).toBe("");
  });

  it("usdCompact abbreviates large values", () => {
    expect(usdCompact(950)).toBe("$950");
    expect(usdCompact(12_500)).toBe("$12.5k");
    expect(usdCompact(2_400_000)).toBe("$2.4M");
  });
});
