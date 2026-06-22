import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createLoginChallenge, verifyLoginSignature } from "./eip712.js";

// Anvil/hardhat well-known test key — never used for real funds.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

async function signChallenge(challenge: ReturnType<typeof createLoginChallenge>, chainId: number) {
  const { signTypedData } = await import("viem/accounts");
  return signTypedData({
    privateKey: TEST_KEY,
    // viem requires chainId as bigint when EIP712Domain declares it uint256.
    domain: { ...challenge.typedData.domain, chainId: BigInt(chainId) },
    types: challenge.typedData.types,
    primaryType: challenge.typedData.primaryType,
    message: challenge.typedData.message,
  });
}

describe("EIP-712 login challenge", () => {
  it("round-trips: sign then verify returns true (chainId 137)", async () => {
    const challenge = createLoginChallenge(137);
    const sig = await signChallenge(challenge, 137);
    const valid = await verifyLoginSignature(
      { nonce: challenge.nonce, issuedAt: challenge.issuedAt, chainId: 137 },
      sig,
      account.address,
    );
    expect(valid).toBe(true);
  });

  it("round-trips: sign then verify returns true (chainId 8453)", async () => {
    const challenge = createLoginChallenge(8453);
    const sig = await signChallenge(challenge, 8453);
    const valid = await verifyLoginSignature(
      { nonce: challenge.nonce, issuedAt: challenge.issuedAt, chainId: 8453 },
      sig,
      account.address,
    );
    expect(valid).toBe(true);
  });

  it("rejects wrong chainId", async () => {
    const challenge = createLoginChallenge(137);
    const sig = await signChallenge(challenge, 137);
    const valid = await verifyLoginSignature(
      { nonce: challenge.nonce, issuedAt: challenge.issuedAt, chainId: 8453 },
      sig,
      account.address,
    );
    expect(valid).toBe(false);
  });

  it("rejects wrong address", async () => {
    const challenge = createLoginChallenge(137);
    const sig = await signChallenge(challenge, 137);
    const valid = await verifyLoginSignature(
      { nonce: challenge.nonce, issuedAt: challenge.issuedAt, chainId: 137 },
      sig,
      "0x0000000000000000000000000000000000000001",
    );
    expect(valid).toBe(false);
  });
});
