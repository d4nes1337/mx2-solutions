/**
 * R-009 contract tests for the POLY_1271 seam: the order struct invariants and
 * the ERC-7739 signature envelope, verified cryptographically against a local
 * throwaway key (the SDK signs; we independently recompute every envelope
 * component with viem and recover the inner signer). Live acceptance stays a
 * staging checkpoint (owner guide) — these tests pin the format so an SDK
 * update can never silently change what we submit.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { build1271SignedOrder, type Eip712Payload } from "./clob-v2-session.js";

const LOCAL_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(LOCAL_KEY);
const DEPOSIT_WALLET = "0x997c95d8be61d5779edfb49aaf5dd83d85f31434";
// CTF Exchange V2 (Polygon) — from the SDK's getContractConfig(137); NOT the
// legacy V1 exchange (0x4bFb…) documented in INTEGRATION §10.
const EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
const CHAIN_ID = 137;

const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";

const sign = async (payload: Eip712Payload): Promise<string> =>
  account.signTypedData(payload as never);

const buildOrder = () =>
  build1271SignedOrder(
    {
      signerAddress: account.address,
      sign,
      depositWalletAddress: DEPOSIT_WALLET,
      chainId: CHAIN_ID,
    },
    {
      tokenId: "123456789",
      side: "BUY",
      price: 0.47,
      size: 50,
      tickSize: "0.01",
      negRisk: false,
      orderType: "GTC",
      postOnly: true,
    },
  );

describe("build1271SignedOrder (R-009 contract)", () => {
  it("builds the V2 struct with maker = signer = funder = deposit wallet, sigType 3", async () => {
    const order = await buildOrder();
    expect(order["maker"]).toBe(DEPOSIT_WALLET);
    expect(order["signer"]).toBe(DEPOSIT_WALLET);
    expect(order["signatureType"]).toBe(3);
    expect(order["tokenId"]).toBe("123456789");
    // BUY at 0.47 for 50 shares → maker pays 23.5 USDC (6dp), receives 50 shares.
    expect(order["makerAmount"]).toBe("23500000");
    expect(order["takerAmount"]).toBe("50000000");
    expect(order["side"]).toBe("BUY");
  });

  it("produces the ERC-7739 envelope: innerSig ‖ domainSep ‖ contentsHash ‖ typeString ‖ len", async () => {
    const order = await buildOrder();
    const sig = order["signature"] as Hex;

    // Fixed layout per SDK source (INTEGRATION §12a): 65-byte inner ECDSA sig,
    // 32-byte app domain separator, 32-byte contents hash, the Order type
    // string, and a 2-byte big-endian length suffix (0x00ba = 186).
    const body = sig.slice(2);
    const innerSig = `0x${body.slice(0, 130)}` as Hex;
    const domainSep = `0x${body.slice(130, 194)}` as Hex;
    const contentsHash = `0x${body.slice(194, 258)}` as Hex;
    const typeStringHex = `0x${body.slice(258, body.length - 4)}` as Hex;
    const lenSuffix = body.slice(body.length - 4);

    expect(lenSuffix).toBe("00ba"); // 186
    expect(typeStringHex).toBe(toHex(ORDER_TYPE_STRING));

    // Recompute the CTF Exchange V2 app domain separator independently.
    const domainTypeHash = keccak256(
      toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const expectedDomainSep = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [
          domainTypeHash,
          keccak256(toHex("Polymarket CTF Exchange")),
          keccak256(toHex("2")),
          BigInt(CHAIN_ID),
          EXCHANGE_V2,
        ],
      ),
    );
    expect(domainSep.toLowerCase()).toBe(expectedDomainSep.toLowerCase());

    // Recompute the contents (Order struct) hash independently.
    const expectedContentsHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint8" },
          { type: "uint8" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [
          keccak256(toHex(ORDER_TYPE_STRING)),
          BigInt(order["salt"] as string),
          order["maker"] as Hex,
          order["signer"] as Hex,
          BigInt(order["tokenId"] as string),
          BigInt(order["makerAmount"] as string),
          BigInt(order["takerAmount"] as string),
          0, // BUY
          3, // POLY_1271
          BigInt(order["timestamp"] as string),
          order["metadata"] as Hex,
          order["builder"] as Hex,
        ],
      ),
    );
    expect(contentsHash.toLowerCase()).toBe(expectedContentsHash.toLowerCase());

    // The inner signature must verify as the EOA signing the TypedDataSign
    // envelope: Order nested under the deposit wallet's ERC-1271 domain.
    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: "Polymarket CTF Exchange",
        version: "2",
        chainId: CHAIN_ID,
        verifyingContract: EXCHANGE_V2,
      },
      types: {
        TypedDataSign: [
          { name: "contents", type: "Order" },
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
          { name: "salt", type: "bytes32" },
        ],
        Order: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "signer", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "makerAmount", type: "uint256" },
          { name: "takerAmount", type: "uint256" },
          { name: "side", type: "uint8" },
          { name: "signatureType", type: "uint8" },
          { name: "timestamp", type: "uint256" },
          { name: "metadata", type: "bytes32" },
          { name: "builder", type: "bytes32" },
        ],
      },
      primaryType: "TypedDataSign",
      message: {
        contents: {
          salt: order["salt"],
          maker: order["maker"],
          signer: order["signer"],
          tokenId: order["tokenId"],
          makerAmount: order["makerAmount"],
          takerAmount: order["takerAmount"],
          side: 0,
          signatureType: 3,
          timestamp: order["timestamp"],
          metadata: order["metadata"],
          builder: order["builder"],
        },
        name: "DepositWallet",
        version: "1",
        chainId: BigInt(CHAIN_ID),
        verifyingContract: DEPOSIT_WALLET,
        salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
      } as never,
      signature: innerSig,
    });
    expect(valid).toBe(true);
  });

  it("rejects prices outside the tick-size band before signing", async () => {
    await expect(
      build1271SignedOrder(
        { signerAddress: account.address, sign, depositWalletAddress: DEPOSIT_WALLET },
        {
          tokenId: "1",
          side: "BUY",
          price: 0.999,
          size: 10,
          tickSize: "0.01",
          negRisk: false,
          orderType: "GTC",
        },
      ),
    ).rejects.toThrow(/invalid price/);
  });
});
