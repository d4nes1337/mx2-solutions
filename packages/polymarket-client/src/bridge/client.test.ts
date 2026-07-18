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

  it("createDepositAddresses sends { address } and unwraps the live { address: {...} } map", async () => {
    // Live Bridge shape (verified 2026-07-18): request field is `address`, the
    // response nests the family map under `address` (singular), and the Tron
    // family key is `tron` — normalized to our canonical `tvm`.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(
        {
          address: {
            evm: "0x1111111111111111111111111111111111111111",
            svm: "solana-address",
            tron: "tron-address",
            btc: "bc1address",
          },
          note: "Only certain chains and tokens are supported.",
          warnings: [{ code: "missing_builder_code", message: "..." }],
        },
        201,
      ),
    );

    const result = await createBridgeClient({
      baseUrl: "https://bridge.example.test",
      builderCode: "not-bytes32",
    }).createDepositAddresses({
      polymarketWalletAddress: "0x2222222222222222222222222222222222222222",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evm).toBe("0x1111111111111111111111111111111111111111");
    expect(result.value.svm).toBe("solana-address");
    expect(result.value.btc).toBe("bc1address");
    // `tron` folded into the canonical `tvm` family key.
    expect(result.value.tvm).toBe("tron-address");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/deposit");
    expect(JSON.parse(String(init?.body))).toEqual({
      address: "0x2222222222222222222222222222222222222222",
    });
    // Malformed builder attribution is dropped, not forwarded.
    expect((init?.headers as Record<string, string>)["X-Builder-Code"]).toBeUndefined();
  });

  it("parses a quote response (documented shape) and tolerates unknown fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        quoteId: "q-1",
        estCheckoutTimeMs: 45_000,
        estToTokenBaseUnit: 4_950_000,
        estInputUsd: 5,
        estOutputUsd: 4.95,
        estFeeBreakdown: {
          appFeeLabel: "Fun.xyz fee",
          appFeeUsd: 0.01,
          gasUsd: 0.02,
          minReceived: 4.9,
          futureField: "ignored",
        },
        someNewField: true,
      }),
    );

    const result = await createBridgeClient({ baseUrl: "https://bridge.example.test" }).getQuote({
      fromAmountBaseUnit: "5000000",
      fromChainId: "8453",
      fromTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      recipientAddress: "0x2222222222222222222222222222222222222222",
      toChainId: "137",
      toTokenAddress: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quoteId).toBe("q-1");
    expect(result.value.estToTokenBaseUnit).toBe("4950000");
    expect(result.value.estFeeBreakdown?.minReceived).toBe(4.9);
  });

  it("createWithdrawalAddresses sends the documented body and unwraps the address map", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        address: { evm: "0x3333333333333333333333333333333333333333" },
        note: "Send funds to these addresses",
      }),
    );

    const result = await createBridgeClient({
      baseUrl: "https://bridge.example.test",
    }).createWithdrawalAddresses({
      polymarketWalletAddress: "0x2222222222222222222222222222222222222222",
      toChainId: "8453",
      toTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      recipientAddr: "0x4444444444444444444444444444444444444444",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evm).toBe("0x3333333333333333333333333333333333333333");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/withdraw");
    expect(JSON.parse(String(init?.body))).toEqual({
      address: "0x2222222222222222222222222222222222222222",
      toChainId: "8453",
      toTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      recipientAddr: "0x4444444444444444444444444444444444444444",
    });
  });

  it("parses status transactions and never hard-fails on unknown provider statuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        transactions: [
          {
            fromChainId: 8453,
            fromTokenAddress: "0x8335",
            fromAmountBaseUnit: "5000000",
            status: "COMPLETED",
            txHash: "0xabc",
            createdTimeMs: 1_784_000_000_000,
          },
          { status: "SOME_FUTURE_STATE" },
        ],
      }),
    );

    const result = await createBridgeClient({ baseUrl: "https://bridge.example.test" }).getStatus(
      "0x3333333333333333333333333333333333333333",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transactions).toHaveLength(2);
    expect(result.value.transactions[0]?.fromChainId).toBe("8453");
    expect(result.value.transactions[0]?.status).toBe("COMPLETED");
    expect(result.value.transactions[1]?.status).toBe("SOME_FUTURE_STATE");
  });

  it("maps 429 to a rate-limit error on the new endpoints", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse({ error: "slow down" }, 429));
    const result = await createBridgeClient({ baseUrl: "https://bridge.example.test" }).getStatus(
      "0x33",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RATE_LIMIT");
  });
});
