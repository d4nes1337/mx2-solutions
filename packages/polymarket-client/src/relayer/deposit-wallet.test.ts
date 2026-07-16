import { describe, expect, it } from "vitest";
import {
  createDepositWalletRelayer,
  createDisabledDepositWalletRelayer,
  isDepositWalletConfirmed,
  type DepositWalletRelayerClient,
} from "./deposit-wallet.js";

const owner = { ownerAddress: "0x1111111111111111111111111111111111111111" };
const depositWalletAddress = "0x2222222222222222222222222222222222222222";

/** Base client stub — tests override the ops they exercise. */
const stubClient = (
  over: Partial<DepositWalletRelayerClient> = {},
): DepositWalletRelayerClient => ({
  deriveDepositWalletAddress: async () => depositWalletAddress,
  getDeployed: async () => ({ deployed: true }),
  deployDepositWallet: async () => ({ transactionID: "tx-1", state: "STATE_NEW" }),
  executeDepositWalletBatch: async () => ({ transactionID: "batch-1", state: "STATE_EXECUTED" }),
  getTransaction: async () => [{ state: "STATE_CONFIRMED", transactionHash: "0xhash" }],
  ...over,
});

describe("deposit-wallet relayer adapter", () => {
  it("fails closed when disabled", async () => {
    const relayer = createDisabledDepositWalletRelayer();
    const result = await relayer.deriveDepositWalletAddress(owner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RELAYER_DISABLED");
  });

  it("reads deployment status through the injected SDK client", async () => {
    const client = stubClient({
      getDeployed: async (address) => ({ deployed: address === depositWalletAddress }),
    });
    const relayer = createDepositWalletRelayer({ clientForOwner: () => client });

    const status = await relayer.getDeploymentStatus(owner);

    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.depositWalletAddress).toBe(depositWalletAddress);
      expect(status.value.deployed).toBe(true);
      expect(status.value.state).toBe("STATE_CONFIRMED");
    }
  });

  it("can wait for a submitted deployment to be mined", async () => {
    const client = stubClient({
      getDeployed: async () => ({ deployed: false }),
      deployDepositWallet: async () => ({
        transactionID: "tx-1",
        state: "STATE_NEW",
        hash: "0xabc",
        wait: async () => ({ state: "STATE_MINED", transactionHash: "0xdef" }),
      }),
    });
    const relayer = createDepositWalletRelayer({
      clientForOwner: () => client,
      waitForConfirmation: true,
    });

    const deployment = await relayer.deployDepositWallet(owner);

    expect(deployment.ok).toBe(true);
    if (deployment.ok) {
      expect(deployment.value.deployed).toBe(true);
      expect(deployment.value.transactionHash).toBe("0xdef");
    }
  });

  it("recognizes confirmed deployment states", () => {
    expect(isDepositWalletConfirmed("STATE_CONFIRMED")).toBe(true);
    expect(isDepositWalletConfirmed("STATE_MINED")).toBe(true);
    expect(isDepositWalletConfirmed("STATE_NEW")).toBe(false);
    expect(isDepositWalletConfirmed(undefined)).toBe(false);
  });

  it("executes a deposit-wallet batch with a future unix deadline", async () => {
    const captured: { calls?: unknown; wallet?: string; deadline?: string } = {};
    const client = stubClient({
      executeDepositWalletBatch: async (calls, walletAddress, deadline) => {
        captured.calls = calls;
        captured.wallet = walletAddress;
        captured.deadline = deadline;
        return { transactionID: "batch-9", state: "STATE_EXECUTED", transactionHash: "0xbeef" };
      },
    });
    const relayer = createDepositWalletRelayer({ clientForOwner: () => client });

    const before = Math.floor(Date.now() / 1000);
    const res = await relayer.executeBatch(owner, [
      { target: "0x3333333333333333333333333333333333333333", value: "0", data: "0xdead" },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.transactionId).toBe("batch-9");
    expect(res.value.depositWalletAddress).toBe(depositWalletAddress);
    expect(captured.wallet).toBe(depositWalletAddress);
    expect(Number(captured.deadline)).toBeGreaterThanOrEqual(before + 3_600 - 5);
    expect(Array.isArray(captured.calls) && (captured.calls as unknown[]).length).toBe(1);
  });

  it("refuses an empty batch and maps upstream failures", async () => {
    const relayer = createDepositWalletRelayer({ clientForOwner: () => stubClient() });
    const empty = await relayer.executeBatch(owner, []);
    expect(empty.ok).toBe(false);

    const failing = createDepositWalletRelayer({
      clientForOwner: () =>
        stubClient({
          executeDepositWalletBatch: async () => {
            throw new Error("boom");
          },
        }),
    });
    const failed = await failing.executeBatch(owner, [{ target: "0x1", value: "0", data: "0x" }]);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("RELAYER_UPSTREAM_ERROR");
  });

  it("polls a relayer transaction state", async () => {
    const relayer = createDepositWalletRelayer({ clientForOwner: () => stubClient() });
    const state = await relayer.getTransactionState(owner, "batch-9");
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.value.state).toBe("STATE_CONFIRMED");
      expect(state.value.transactionHash).toBe("0xhash");
    }
  });
});
