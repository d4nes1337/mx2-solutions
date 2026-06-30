import { describe, expect, it } from "vitest";
import {
  createDepositWalletRelayer,
  createDisabledDepositWalletRelayer,
  isDepositWalletConfirmed,
  type DepositWalletRelayerClient,
} from "./deposit-wallet.js";

const owner = { ownerAddress: "0x1111111111111111111111111111111111111111" };
const depositWalletAddress = "0x2222222222222222222222222222222222222222";

describe("deposit-wallet relayer adapter", () => {
  it("fails closed when disabled", async () => {
    const relayer = createDisabledDepositWalletRelayer();
    const result = await relayer.deriveDepositWalletAddress(owner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RELAYER_DISABLED");
  });

  it("reads deployment status through the injected SDK client", async () => {
    const client: DepositWalletRelayerClient = {
      deriveDepositWalletAddress: async () => depositWalletAddress,
      getDeployed: async (address) => ({ deployed: address === depositWalletAddress }),
      deployDepositWallet: async () => ({
        transactionID: "tx-1",
        state: "STATE_NEW",
      }),
    };
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
    const client: DepositWalletRelayerClient = {
      deriveDepositWalletAddress: async () => depositWalletAddress,
      getDeployed: async () => ({ deployed: false }),
      deployDepositWallet: async () => ({
        transactionID: "tx-1",
        state: "STATE_NEW",
        hash: "0xabc",
        wait: async () => ({ state: "STATE_MINED", transactionHash: "0xdef" }),
      }),
    };
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
});
