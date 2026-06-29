import { describe, it, expect } from "vitest";
import {
  buildOrderStruct,
  buildOrderTypedData,
  getOrderRawAmounts,
  ROUNDING_CONFIG,
  BYTES32_ZERO,
  SIGNATURE_TYPE_EOA,
} from "./order-builder.js";
import { SIGNATURE_TYPE_POLY_GNOSIS_SAFE } from "./schema.js";

const EOA = "0x77117F39dc33292c657a366643Dd995010b7E36d";

describe("order-builder", () => {
  it("builds an EOA (type 0) order with maker == signer == funder", () => {
    const order = buildOrderStruct(
      {
        tokenId: "123",
        side: "BUY",
        price: "0.5",
        size: "10",
        funder: EOA,
        signer: EOA,
        signatureType: SIGNATURE_TYPE_EOA,
        timestamp: "1700000000000",
      },
      "999",
    );
    expect(order).toEqual({
      salt: "999",
      maker: EOA,
      signer: EOA,
      tokenId: "123",
      makerAmount: "5000000", // 10 * 0.5 USDC (6 decimals)
      takerAmount: "10000000", // 10 shares
      side: "BUY",
      signatureType: 0,
      timestamp: "1700000000000",
      metadata: BYTES32_ZERO,
      builder: BYTES32_ZERO,
      expiration: "0",
    });
  });

  it("defaults signatureType to POLY_GNOSIS_SAFE (legacy browser path)", () => {
    const order = buildOrderStruct({
      tokenId: "1",
      side: "BUY",
      price: "0.5",
      size: "1",
      funder: EOA,
      signer: EOA,
    });
    expect(order.signatureType).toBe(SIGNATURE_TYPE_POLY_GNOSIS_SAFE);
  });

  it("computes SELL amounts (maker = shares, taker = USDC)", () => {
    const { side, rawMakerAmt, rawTakerAmt } = getOrderRawAmounts(
      "SELL",
      10,
      0.5,
      ROUNDING_CONFIG["0.01"],
    );
    expect(side).toBe("SELL");
    expect(rawMakerAmt).toBe(10);
    expect(rawTakerAmt).toBe(5);
  });

  it("produces the exact CTF Exchange V2 typed data (wire format lock)", () => {
    const order = buildOrderStruct(
      {
        tokenId: "123",
        side: "BUY",
        price: "0.5",
        size: "10",
        funder: EOA,
        signer: EOA,
        signatureType: SIGNATURE_TYPE_EOA,
        timestamp: "1700000000000",
      },
      "999",
    );
    const typedData = buildOrderTypedData(order, 137, false);
    expect(typedData.primaryType).toBe("Order");
    expect(typedData.domain).toEqual({
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: 137,
      verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B",
    });
    // side is encoded as uint8 (0 = BUY) in the signed message.
    expect(typedData.message).toEqual({
      salt: "999",
      maker: EOA,
      signer: EOA,
      tokenId: "123",
      makerAmount: "5000000",
      takerAmount: "10000000",
      side: 0,
      signatureType: 0,
      timestamp: "1700000000000",
      metadata: BYTES32_ZERO,
      builder: BYTES32_ZERO,
    });
  });

  it("signs against the neg-risk exchange when negRisk = true", () => {
    const order = buildOrderStruct({
      tokenId: "1",
      side: "BUY",
      price: "0.5",
      size: "1",
      funder: EOA,
      signer: EOA,
    });
    const typedData = buildOrderTypedData(order, 137, true);
    expect(typedData.domain.verifyingContract).toBe("0xe2222d279d744050d28e00520010520000310F59");
  });
});
