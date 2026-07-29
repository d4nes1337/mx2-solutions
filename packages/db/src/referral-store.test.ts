import { describe, expect, it } from "vitest";
import {
  REFERRAL_CODE_RE,
  generateReferralCode,
  isValidReferralCode,
  normalizeReferralCode,
} from "./referral-store.js";

describe("normalizeReferralCode", () => {
  it("uppercases and trims", () => {
    expect(normalizeReferralCode("  ansem ")).toBe("ANSEM");
    expect(normalizeReferralCode("k7q3d2")).toBe("K7Q3D2");
  });
});

describe("isValidReferralCode", () => {
  it("accepts canonical codes between 3 and 20 chars", () => {
    expect(isValidReferralCode("ANSEM")).toBe(true);
    expect(isValidReferralCode("K7Q3D2")).toBe(true);
    expect(isValidReferralCode("ABC")).toBe(true);
    expect(isValidReferralCode("A".repeat(20))).toBe(true);
  });

  it("rejects lowercase, symbols, and bad lengths", () => {
    expect(isValidReferralCode("ansem")).toBe(false);
    expect(isValidReferralCode("AB")).toBe(false);
    expect(isValidReferralCode("A".repeat(21))).toBe(false);
    expect(isValidReferralCode("AN SEM")).toBe(false);
    expect(isValidReferralCode("AN-SEM")).toBe(false);
    expect(isValidReferralCode("")).toBe(false);
  });
});

describe("generateReferralCode", () => {
  it("emits 6-char codes in canonical form from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateReferralCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(REFERRAL_CODE_RE);
      // The confusable characters are deliberately excluded.
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it("respects a custom length", () => {
    expect(generateReferralCode(8)).toHaveLength(8);
  });

  it("does not repeat within a small sample", () => {
    const sample = new Set(Array.from({ length: 500 }, () => generateReferralCode()));
    expect(sample.size).toBe(500);
  });
});
