import { describe, expect, it } from "vitest";
import { buildPreviewRequest } from "./orders";

const base = {
  conditionId: "0xcond",
  tokenId: "123",
  side: "BUY" as const,
  price: "0.5",
  size: "10",
  funder: "0xabc",
};

describe("buildPreviewRequest", () => {
  it("builds a valid request and defaults orderType to GTC", () => {
    const res = buildPreviewRequest(base);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request).toEqual({ ...base, orderType: "GTC" });
    }
  });

  it("rejects missing token id", () => {
    const res = buildPreviewRequest({ ...base, tokenId: undefined });
    expect(res).toEqual({ ok: false, error: "Missing market identifiers." });
  });

  it("rejects missing funder", () => {
    const res = buildPreviewRequest({ ...base, funder: "" });
    expect(res.ok).toBe(false);
  });

  it.each(["0", "1", "1.2", "-0.1", "abc"])("rejects out-of-range price %s", (price) => {
    const res = buildPreviewRequest({ ...base, price });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Price/);
  });

  it.each(["0", "-5", "x"])("rejects non-positive size %s", (size) => {
    const res = buildPreviewRequest({ ...base, size });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Size/);
  });
});
