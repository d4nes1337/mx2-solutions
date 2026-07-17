import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeClient } from "./client.js";

const makeResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("createBridgeClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the supported-assets catalog without coercing current Bridge fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        supportedAssets: [
          {
            chainId: "8453",
            chainName: "Base",
            token: {
              name: "USDC",
              symbol: "USDC",
              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              decimals: 6,
            },
            minCheckoutUsd: 2,
          },
        ],
        note: "Supported assets",
      }),
    );

    const result = await createBridgeClient({
      baseUrl: "https://bridge.example.test",
    }).getSupportedAssets();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supportedAssets[0]?.chainId).toBe("8453");
    expect(result.value.supportedAssets[0]?.token.symbol).toBe("USDC");
  });

  it("omits malformed builder attribution before calling Bridge", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        addresses: {
          evm: "0x1111111111111111111111111111111111111111",
          svm: "solana-address",
          btc: "bc1address",
          tvm: "tron-address",
        },
      }),
    );

    const result = await createBridgeClient({
      baseUrl: "https://bridge.example.test",
      builderCode: "not-bytes32",
    }).createDepositAddresses({
      polymarketWalletAddress: "0x2222222222222222222222222222222222222222",
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>)["X-Builder-Code"]).toBeUndefined();
  });
});
