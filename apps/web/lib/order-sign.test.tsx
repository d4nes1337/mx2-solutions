import { describe, expect, it, vi } from "vitest";
import {
  buildAndSignOrder,
  buildOrderStruct,
  buildOrderTypedData,
  BYTES32_ZERO,
  getOrderRawAmounts,
  ROUNDING_CONFIG,
  SIGNATURE_TYPE_POLY_GNOSIS_SAFE,
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
});
