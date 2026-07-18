import { describe, it, expect, vi } from "vitest";
import {
  FUNDED_THRESHOLD_RAW,
  reconcileAndPersist,
  reconcileInternalStatus,
} from "./reconcile-status.js";

const DEPOSIT = "0x9999999999999999999999999999999999999999";

describe("reconcileInternalStatus (pure)", () => {
  it("no deposit wallet → needs_deposit_wallet", () => {
    expect(
      reconcileInternalStatus({ status: "needs_deposit_wallet", depositWalletAddress: null }, null),
    ).toBe("needs_deposit_wallet");
  });

  it("has deposit wallet, unknown balance → keeps stored status (fail-safe)", () => {
    expect(
      reconcileInternalStatus({ status: "needs_funding", depositWalletAddress: DEPOSIT }, null),
    ).toBe("needs_funding");
  });

  it("has deposit wallet, zero balance → needs_funding (never back to needs_deposit_wallet)", () => {
    expect(
      reconcileInternalStatus(
        { status: "needs_deposit_wallet", depositWalletAddress: DEPOSIT },
        0n,
      ),
    ).toBe("needs_funding");
  });

  it("funded (≥ threshold) → needs_delegation", () => {
    expect(
      reconcileInternalStatus(
        { status: "needs_funding", depositWalletAddress: DEPOSIT },
        FUNDED_THRESHOLD_RAW,
      ),
    ).toBe("needs_delegation");
  });

  it("just below threshold stays needs_funding", () => {
    expect(
      reconcileInternalStatus(
        { status: "needs_funding", depositWalletAddress: DEPOSIT },
        FUNDED_THRESHOLD_RAW - 1n,
      ),
    ).toBe("needs_funding");
  });

  it("never regresses an already-advanced account, even with zero balance", () => {
    for (const status of ["needs_delegation", "needs_credentials", "ready", "disabled"]) {
      expect(reconcileInternalStatus({ status, depositWalletAddress: DEPOSIT }, 0n)).toBe(status);
    }
  });
});

describe("reconcileAndPersist", () => {
  const makeStore = () => {
    const updateStatus = vi.fn(async () => {});
    return { updateStatus };
  };

  it("promotes a funded internal account and persists it once", async () => {
    const store = makeStore();
    const reader = { erc20Balance: vi.fn(async () => 10_000_000n) } as never;
    const next = await reconcileAndPersist(
      { id: "a1", kind: "internal_privy", status: "needs_funding", depositWalletAddress: DEPOSIT },
      reader,
      store,
    );
    expect(next).toBe("needs_delegation");
    expect(store.updateStatus).toHaveBeenCalledTimes(1);
    expect(store.updateStatus).toHaveBeenCalledWith("a1", "needs_delegation");
  });

  it("skips the RPC read for advanced accounts", async () => {
    const store = makeStore();
    const erc20Balance = vi.fn(async () => 0n);
    const next = await reconcileAndPersist(
      { id: "a1", kind: "internal_privy", status: "ready", depositWalletAddress: DEPOSIT },
      { erc20Balance } as never,
      store,
    );
    expect(next).toBe("ready");
    expect(erc20Balance).not.toHaveBeenCalled();
    expect(store.updateStatus).not.toHaveBeenCalled();
  });

  it("leaves external accounts untouched", async () => {
    const store = makeStore();
    const erc20Balance = vi.fn(async () => 10_000_000n);
    const next = await reconcileAndPersist(
      {
        id: "e1",
        kind: "external_wallet",
        status: "needs_credentials",
        depositWalletAddress: null,
      },
      { erc20Balance } as never,
      store,
    );
    expect(next).toBe("needs_credentials");
    expect(erc20Balance).not.toHaveBeenCalled();
  });

  it("no reader → stored status, no write", async () => {
    const store = makeStore();
    const next = await reconcileAndPersist(
      { id: "a1", kind: "internal_privy", status: "needs_funding", depositWalletAddress: DEPOSIT },
      null,
      store,
    );
    expect(next).toBe("needs_funding");
    expect(store.updateStatus).not.toHaveBeenCalled();
  });

  it("RPC failure → keeps stored status (fail-safe)", async () => {
    const store = makeStore();
    const reader = {
      erc20Balance: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    } as never;
    const next = await reconcileAndPersist(
      { id: "a1", kind: "internal_privy", status: "needs_funding", depositWalletAddress: DEPOSIT },
      reader,
      store,
    );
    expect(next).toBe("needs_funding");
    expect(store.updateStatus).not.toHaveBeenCalled();
  });

  it("does not persist when status is unchanged (funded-but-zero stays needs_funding)", async () => {
    const store = makeStore();
    const reader = { erc20Balance: vi.fn(async () => 0n) } as never;
    const next = await reconcileAndPersist(
      { id: "a1", kind: "internal_privy", status: "needs_funding", depositWalletAddress: DEPOSIT },
      reader,
      store,
    );
    expect(next).toBe("needs_funding");
    expect(store.updateStatus).not.toHaveBeenCalled();
  });
});
