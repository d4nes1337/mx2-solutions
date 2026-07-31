import { describe, expect, it, vi } from "vitest";
import {
  buildAndSignOrder,
  buildOrderStruct,
  buildOrderTypedData,
  BYTES32_ZERO,
  getOrderRawAmounts,
  normalizeSignatureV,
  ROUNDING_CONFIG,
  SIGNATURE_TYPE_POLY_GNOSIS_SAFE,
  signTypedData,
} from "./order-sign";

const FUNDER = "0x997C95D8BE61D5779EdfB49aAF5dD83d85f31434";
const SIGNER = "0x77117F39dc33292c657a366643Dd995010b7E36d";
const TOKEN = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const BUILDER = "0xe6121e8b7691171b67b6063142c42bfbf8ecf86b1b891bdf52f17d1aecea6be0";

describe("getOrderRawAmounts", () => {
  it("BUY: taker = shares, maker = shares*price", () => {
    const r = getOrderRawAmounts("BUY", 10, 0.5, ROUNDING_CONFIG["0.01"]);
    expect(r).toEqual({ side: "BUY", rawTakerAmt: 10, rawMakerAmt: 5 });
  });
  it("SELL: maker = shares, taker = shares*price", () => {
    const r = getOrderRawAmounts("SELL", 10, 0.5, ROUNDING_CONFIG["0.01"]);
    expect(r).toEqual({ side: "SELL", rawMakerAmt: 10, rawTakerAmt: 5 });
  });
});

describe("buildOrderStruct", () => {
  it("builds a V2 BUY order with signatureType 2 and builder metadata", () => {
    const o = buildOrderStruct(
      {
        tokenId: TOKEN,
        side: "BUY",
        price: "0.5",
        size: "10",
        funder: FUNDER,
        signer: SIGNER,
        builderCode: BUILDER,
        timestamp: "1700000000000",
      },
      "12345",
    );
    expect(o).toMatchObject({
      salt: "12345",
      maker: FUNDER,
      signer: SIGNER,
      tokenId: TOKEN,
      makerAmount: "5000000",
      takerAmount: "10000000",
      side: "BUY",
      signatureType: SIGNATURE_TYPE_POLY_GNOSIS_SAFE,
      timestamp: "1700000000000",
      metadata: BYTES32_ZERO,
      builder: BUILDER,
      expiration: "0",
    });
    expect(o).not.toHaveProperty("taker");
    expect(o).not.toHaveProperty("nonce");
  });
});

describe("buildOrderTypedData", () => {
  const order = buildOrderStruct(
    {
      tokenId: TOKEN,
      side: "BUY",
      price: "0.5",
      size: "10",
      funder: FUNDER,
      signer: SIGNER,
      timestamp: "1700000000000",
    },
    "12345",
  );

  it("uses the CTF Exchange V2 domain and order struct", () => {
    const td = buildOrderTypedData(order, 137, false);
    expect(td.primaryType).toBe("Order");
    expect(td.types.Order).toHaveLength(11);
    expect(td.domain).toMatchObject({
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: 137,
      verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B",
    });
    expect(td.message).toMatchObject({
      salt: "12345",
      side: 0,
      signatureType: 2,
      timestamp: "1700000000000",
      metadata: BYTES32_ZERO,
    });
    expect(td.message).not.toHaveProperty("taker");
  });

  it("uses the neg-risk exchange for neg-risk markets", () => {
    const td = buildOrderTypedData(order, 137, true);
    expect(td.domain.verifyingContract).toBe("0xe2222d279d744050d28e00520010520000310F59");
  });
});

describe("buildAndSignOrder", () => {
  it("signs V2 typed data via eth_signTypedData_v4", async () => {
    const provider = { request: vi.fn().mockResolvedValue("0xdeadbeef") };
    const signed = await buildAndSignOrder(provider, {
      tokenId: TOKEN,
      side: "BUY",
      price: "0.5",
      size: "10",
      funder: FUNDER,
      signer: SIGNER,
      chainId: 137,
      negRisk: false,
      timestamp: "1700000000000",
    });
    expect(provider.request).toHaveBeenCalledOnce();
    const call = provider.request.mock.calls[0]![0];
    expect(call.method).toBe("eth_signTypedData_v4");
    const typed = JSON.parse(call.params[1] as string);
    expect(typed.domain.version).toBe("2");
    expect(typed.message.maker).toBe(FUNDER);
    expect(signed.signature).toBe("0xdeadbeef");
    expect(signed.side).toBe("BUY");
  });

  it("carries the trading account's signatureType into the signed struct", async () => {
    const provider = { request: vi.fn().mockResolvedValue("0xdeadbeef") };
    const signed = await buildAndSignOrder(provider, {
      tokenId: TOKEN,
      side: "BUY",
      price: "0.5",
      size: "10",
      funder: SIGNER, // EOA path: maker == signer
      signer: SIGNER,
      signatureType: 0,
      chainId: 137,
      timestamp: "1700000000000",
    });
    expect(signed.signatureType).toBe(0);
    const typed = JSON.parse(provider.request.mock.calls[0]![0].params[1] as string);
    expect(typed.message.signatureType).toBe(0);
  });

  it("signs against the neg-risk exchange when the preview says negRisk", async () => {
    const provider = { request: vi.fn().mockResolvedValue("0xdeadbeef") };
    await buildAndSignOrder(provider, {
      tokenId: TOKEN,
      side: "BUY",
      price: "0.5",
      size: "10",
      funder: FUNDER,
      signer: SIGNER,
      chainId: 137,
      negRisk: true,
      timestamp: "1700000000000",
    });
    const typed = JSON.parse(provider.request.mock.calls[0]![0].params[1] as string);
    expect(typed.domain.verifyingContract).toBe("0xe2222d279d744050d28e00520010520000310F59");
  });
});

// ── Cross-wallet signing compatibility ───────────────────────────────────────

const R_S = "11".repeat(64); // 64 bytes of r||s

describe("normalizeSignatureV", () => {
  it("lifts a 0/1 recovery id to 27/28", () => {
    expect(normalizeSignatureV(`0x${R_S}00`)).toBe(`0x${R_S}1b`);
    expect(normalizeSignatureV(`0x${R_S}01`)).toBe(`0x${R_S}1c`);
  });

  it("leaves an already-canonical signature untouched", () => {
    expect(normalizeSignatureV(`0x${R_S}1b`)).toBe(`0x${R_S}1b`);
    expect(normalizeSignatureV(`0x${R_S}1c`)).toBe(`0x${R_S}1c`);
  });

  // EIP-1271 / ERC-6492 envelopes are not 65-byte ECDSA and must not be edited.
  it("leaves non-65-byte payloads untouched", () => {
    const envelope = `0x${"ab".repeat(200)}`;
    expect(normalizeSignatureV(envelope)).toBe(envelope);
    expect(normalizeSignatureV("0x")).toBe("0x");
  });
});

describe("signTypedData", () => {
  const typedData = { primaryType: "Order", domain: {}, types: {}, message: {} };

  it("sends the JSON-string param shape wallets normally expect", async () => {
    const provider = { request: vi.fn().mockResolvedValue(`0x${R_S}1b`) };
    await signTypedData(provider, SIGNER, typedData);
    expect(provider.request).toHaveBeenCalledOnce();
    expect(typeof provider.request.mock.calls[0]![0].params[1]).toBe("string");
  });

  it("retries with the object param shape when a wallet rejects the string", async () => {
    const provider = {
      request: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("invalid params"), { code: -32602 }))
        .mockResolvedValueOnce(`0x${R_S}1b`),
    };
    const sig = await signTypedData(provider, SIGNER, typedData);
    expect(provider.request).toHaveBeenCalledTimes(2);
    expect(provider.request.mock.calls[1]![0].params[1]).toBe(typedData);
    expect(sig).toBe(`0x${R_S}1b`);
  });

  // Re-prompting after a decline would be hostile — and the second prompt
  // would look to the user like the app ignoring their "no".
  it("never re-prompts after a user rejection", async () => {
    const provider = {
      request: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("User rejected the request."), { code: 4001 })),
    };
    await expect(signTypedData(provider, SIGNER, typedData)).rejects.toMatchObject({ code: 4001 });
    expect(provider.request).toHaveBeenCalledOnce();
  });

  it("normalizes the recovery id of whatever the wallet returns", async () => {
    const provider = { request: vi.fn().mockResolvedValue(`0x${R_S}00`) };
    await expect(signTypedData(provider, SIGNER, typedData)).resolves.toBe(`0x${R_S}1b`);
  });
});
