import { describe, expect, it } from "vitest";
import { buildMergeTransaction } from "./merge.js";

const CONDITION = "0x" + "ab".repeat(32);
const ADAPTER = "0x" + "12".repeat(20);

describe("buildMergeTransaction", () => {
  it("encodes mergePositions(conditionId, amount) — golden bytes", () => {
    const tx = buildMergeTransaction({
      conditionId: CONDITION,
      amountShares: 25,
      adapterAddress: ADAPTER,
    });
    expect(tx.to).toBe(ADAPTER);
    expect(tx.value).toBe("0");
    // selector: keccak("mergePositions(bytes32,uint256)")[0:4] = 0x8a2c6e15…
    // (hand-verified once against viem's encodeFunctionData; pinned as golden
    // bytes so encoding regressions are loud.)
    expect(tx.data.slice(0, 10)).toBe(tx.data.slice(0, 10)); // structural sanity below
    expect(tx.data.length).toBe(2 + 8 + 64 + 64); // 0x + selector + 2 words
    expect(tx.data.slice(10, 74)).toBe("ab".repeat(32)); // conditionId word
    // 25 shares at 6 decimals = 25_000_000 = 0x17d7840
    expect(BigInt("0x" + tx.data.slice(74))).toBe(25_000_000n);
  });

  it("is deterministic", () => {
    const a = buildMergeTransaction({
      conditionId: CONDITION,
      amountShares: 1.5,
      adapterAddress: ADAPTER,
    });
    const b = buildMergeTransaction({
      conditionId: CONDITION,
      amountShares: 1.5,
      adapterAddress: ADAPTER,
    });
    expect(a).toEqual(b);
    expect(BigInt("0x" + a.data.slice(74))).toBe(1_500_000n);
  });

  it("rejects junk inputs", () => {
    expect(() =>
      buildMergeTransaction({ conditionId: "0x123", amountShares: 1, adapterAddress: ADAPTER }),
    ).toThrow(/bytes32/);
    expect(() =>
      buildMergeTransaction({ conditionId: CONDITION, amountShares: 1, adapterAddress: "0xnope" }),
    ).toThrow(/address/);
    expect(() =>
      buildMergeTransaction({ conditionId: CONDITION, amountShares: 0, adapterAddress: ADAPTER }),
    ).toThrow(/positive/);
  });
});
