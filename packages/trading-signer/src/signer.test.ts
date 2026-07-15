import { describe, it, expect } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createMockTradingSigner } from "./mock-adapter.js";
import { createPrivyTradingSigner, type PrivySigningClient } from "./privy-adapter.js";
import type { Eip712TypedData, TradingWalletRef } from "./types.js";

const TEST_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;

const typedData: Eip712TypedData = {
  primaryType: "Order",
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Order: [
      { name: "salt", type: "uint256" },
      { name: "maker", type: "address" },
    ],
  },
  domain: {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: 137,
    verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B",
  },
  message: { salt: "999", maker: "0x77117F39dc33292c657a366643Dd995010b7E36d" },
};

const wallet: TradingWalletRef = { walletId: "w1", address: "0xabc" };

describe("mock trading signer", () => {
  const signer = createMockTradingSigner({ privateKey: TEST_KEY });

  it("signs typed data deterministically and recoverably", async () => {
    const a = await signer.signOrder({ wallet, typedData });
    const b = await signer.signOrder({ wallet, typedData });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.signature).toBe(b.value.signature); // deterministic ECDSA
    expect(a.value.signature).toMatch(/^0x[0-9a-f]{130}$/);

    const account = privateKeyToAccount(TEST_KEY);
    const { EIP712Domain: _omit, ...types } = typedData.types;
    const recovered = await recoverTypedDataAddress({
      domain: typedData.domain,
      types,
      primaryType: "Order",
      message: typedData.message,
      signature: a.value.signature as `0x${string}`,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("provisions a wallet with a stable id + the account address", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const r1 = await signer.provisionWallet("user-1");
    const r2 = await signer.provisionWallet("user-1");
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value).toEqual(r2.value);
    expect(r1.value.address).toBe(account.address);
  });
});

describe("privy trading signer adapter", () => {
  it("maps calls to the injected client", async () => {
    const calls: string[] = [];
    const client: PrivySigningClient = {
      async createWallet(p) {
        calls.push(`create:${p.ownerUserId}`);
        return { id: "pw-1", address: "0xdead" };
      },
      async getWallet(p) {
        calls.push(`get:${p.walletId}`);
        return p.walletId === "gone" ? null : { id: p.walletId, address: "0xdead" };
      },
      async signTypedData(p) {
        calls.push(`sign:${p.walletId}:${p.typedData.primaryType}`);
        return { signature: "0xsig" };
      },
      async sendTransaction(p) {
        calls.push(`tx:${p.walletId}:${p.to}:${p.value ?? "0"}`);
        return { txHash: "0xhash" };
      },
    };
    const signer = createPrivyTradingSigner(client);

    const prov = await signer.provisionWallet("user-9");
    const sig = await signer.signOrder({ wallet, typedData });
    const tx = await signer.sendTransaction({ wallet, to: "0xExchange", data: "0x", value: "0x5" });
    const alive = await signer.getWalletStatus("pw-1");
    const gone = await signer.getWalletStatus("gone");

    expect(prov.ok && prov.value.walletId).toBe("pw-1");
    expect(sig.ok && sig.value.signature).toBe("0xsig");
    expect(tx.ok && tx.value.txHash).toBe("0xhash");
    expect(alive.ok && alive.value).toBe("active");
    expect(gone.ok && gone.value).toBe("not_found");
    expect(calls).toEqual([
      "create:user-9",
      "sign:w1:Order",
      "tx:w1:0xExchange:0x5",
      "get:pw-1",
      "get:gone",
    ]);
  });

  it("maps a transient getWallet failure to an error, never a not_found", async () => {
    const client: PrivySigningClient = {
      async createWallet() {
        return { id: "x", address: "0x" };
      },
      async getWallet() {
        throw new Error("network timeout");
      },
      async signTypedData() {
        return { signature: "0x" };
      },
      async sendTransaction() {
        return { txHash: "0x" };
      },
    };
    const signer = createPrivyTradingSigner(client);
    const res = await signer.getWalletStatus("pw-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NETWORK_ERROR");
  });

  it("translates a policy denial into POLICY_DENIED", async () => {
    const client: PrivySigningClient = {
      async createWallet() {
        return { id: "x", address: "0x" };
      },
      async getWallet() {
        return { id: "x", address: "0x" };
      },
      async signTypedData() {
        throw new Error("Transaction denied by wallet policy");
      },
      async sendTransaction() {
        return { txHash: "0x" };
      },
    };
    const signer = createPrivyTradingSigner(client);
    const res = await signer.signOrder({ wallet, typedData });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("POLICY_DENIED");
  });
});
