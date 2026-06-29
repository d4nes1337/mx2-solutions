import { describe, it, expect } from "vitest";
import { err } from "@mx2/core";
import type { AuditStore, PrivyWalletStore, PrivyWalletRow } from "@mx2/db";
import { createMockTradingSigner, type TradingSigner } from "@mx2/trading-signer";
import {
  ensureAllowances,
  ALLOWANCE_SPENDERS,
  type AllowanceReader,
} from "./allowance-bootstrap.js";

const MAX = 2n ** 256n - 1n;

const walletRow = (bootstrapped: boolean): PrivyWalletRow => ({
  walletAddress: "0xowner",
  privyUserId: "0xowner",
  privyWalletId: "pw-1",
  embeddedAddress: "0x1111111111111111111111111111111111111111",
  policyId: "policy-1",
  allowancesBootstrappedAt: bootstrapped ? new Date() : null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const noAllowances: AllowanceReader = {
  erc20Allowance: async () => 0n,
  isApprovedForAll: async () => false,
};
const fullAllowances: AllowanceReader = {
  erc20Allowance: async () => MAX,
  isApprovedForAll: async () => true,
};

const makeDeps = (over: { reader: AllowanceReader; signer?: TradingSigner }) => {
  const audits: string[] = [];
  let marked: string | null = null;
  const auditStore: AuditStore = {
    emit: async (e) => {
      audits.push(e.action);
      return {
        id: "a",
        actor: e.actor,
        action: e.action,
        subject: e.subject ?? null,
        metadata: e.metadata,
        createdAt: new Date(),
      };
    },
    recent: async () => [],
    forActor: async () => [],
  };
  const privyWallets: PrivyWalletStore = {
    upsert: async () => {
      throw new Error("nope");
    },
    find: async () => null,
    markAllowancesBootstrapped: async (w) => {
      marked = w;
    },
  };
  return {
    deps: {
      signer: over.signer ?? createMockTradingSigner({ privateKey: `0x${"2".repeat(64)}` }),
      reader: over.reader,
      privyWallets,
      auditStore,
    },
    audits,
    getMarked: () => marked,
  };
};

describe("ensureAllowances", () => {
  it("returns immediately when already bootstrapped (no signing)", async () => {
    const { deps, audits } = makeDeps({ reader: noAllowances });
    const res = await ensureAllowances(deps, walletRow(true));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.txHashes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("approves USDC + CTF for every spender when none exist", async () => {
    const { deps, audits, getMarked } = makeDeps({ reader: noAllowances });
    const res = await ensureAllowances(deps, walletRow(false));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 2 spenders × (USDC approve + CTF setApprovalForAll) = 4 transactions.
    expect(res.value.txHashes).toHaveLength(ALLOWANCE_SPENDERS.length * 2);
    expect(getMarked()).toBe("0xowner");
    expect(audits.filter((a) => a === "allowance.approve.submitted")).toHaveLength(4);
    expect(audits.at(-1)).toBe("allowance.approve.confirmed");
  });

  it("skips approvals that already exist but still marks bootstrapped", async () => {
    const { deps, getMarked } = makeDeps({ reader: fullAllowances });
    const res = await ensureAllowances(deps, walletRow(false));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.txHashes).toEqual([]);
    expect(getMarked()).toBe("0xowner");
  });

  it("fails closed (no mark) when a signer transaction fails", async () => {
    const failingSigner: TradingSigner = {
      ...createMockTradingSigner({ privateKey: `0x${"2".repeat(64)}` }),
      sendTransaction: async () => err({ code: "POLICY_DENIED", message: "blocked by policy" }),
    };
    const { deps, audits, getMarked } = makeDeps({ reader: noAllowances, signer: failingSigner });
    const res = await ensureAllowances(deps, walletRow(false));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("POLICY_DENIED");
    expect(getMarked()).toBeNull(); // never marked bootstrapped
    expect(audits).toContain("allowance.failed");
    expect(audits).not.toContain("allowance.approve.confirmed");
  });
});
