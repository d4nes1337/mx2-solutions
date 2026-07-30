import { describe, expect, it, vi } from "vitest";
import { ensurePolygonChain } from "./chain";

const providerOn = (chainIdHex: string) => ({
  request: vi.fn(async ({ method }: { method: string; params: unknown[] }) => {
    if (method === "eth_chainId") return chainIdHex;
    return null as unknown as string;
  }),
});

describe("ensurePolygonChain", () => {
  it("is a no-op when the wallet is already on Polygon", async () => {
    const provider = providerOn("0x89");
    const res = await ensurePolygonChain(provider);
    expect(res).toEqual({ ok: true, switched: false });
    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it("switches the wallet when it is on another chain", async () => {
    const provider = providerOn("0x1");
    const res = await ensurePolygonChain(provider);
    expect(res).toEqual({ ok: true, switched: true });
    expect(provider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
  });

  it("offers to add Polygon when the wallet does not know it (4902)", async () => {
    const calls: string[] = [];
    const provider = {
      request: vi.fn(async ({ method }: { method: string; params: unknown[] }) => {
        calls.push(method);
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") {
          throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        }
        return null as unknown as string;
      }),
    };
    const res = await ensurePolygonChain(provider);
    expect(res).toEqual({ ok: true, switched: true });
    expect(calls).toContain("wallet_addEthereumChain");
  });

  it("reports a user rejection without throwing (signing still proceeds)", async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string; params: unknown[] }) => {
        if (method === "eth_chainId") return "0x1";
        throw Object.assign(new Error("User rejected"), { code: 4001 });
      }),
    };
    const res = await ensurePolygonChain(provider);
    expect(res).toEqual({ ok: false, reason: "rejected" });
  });

  it("never throws even on a provider with no chain support", async () => {
    const provider = {
      request: vi.fn(async () => {
        throw new Error("method not supported");
      }),
    };
    const res = await ensurePolygonChain(provider);
    expect(res).toEqual({ ok: false, reason: "unsupported" });
  });
});
