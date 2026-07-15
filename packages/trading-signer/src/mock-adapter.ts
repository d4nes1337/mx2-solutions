import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ok, err } from "@mx2/core";
import type { Result } from "@mx2/core";
import type {
  TradingSigner,
  SignerError,
  SignTypedDataRequest,
  SendTransactionRequest,
  Eip712TypedData,
} from "./types.js";

/**
 * Local-key signer for tests, local dev, and the live-OFF dry-run. Signs with a
 * viem account from a configured test key. NEVER wire a production key here — this
 * exists precisely so the entire system can be exercised without Privy or MetaMask.
 */
export interface MockTradingSignerOptions {
  /** A test/dev private key (0x-prefixed, 32 bytes). NEVER a production key. */
  privateKey: `0x${string}`;
}

// viem derives the EIP712Domain itself and rejects it being present in `types`.
const toViemTypedData = (td: Eip712TypedData) => {
  const { EIP712Domain: _omit, ...types } = td.types;
  return { domain: td.domain, types, primaryType: td.primaryType, message: td.message };
};

export const createMockTradingSigner = (opts: MockTradingSignerOptions): TradingSigner => {
  const account = privateKeyToAccount(opts.privateKey);

  const sign = async (
    req: SignTypedDataRequest,
  ): Promise<Result<{ signature: string }, SignerError>> => {
    try {
      const viemTd = toViemTypedData(req.typedData);
      const signature = await account.signTypedData(
        viemTd as unknown as Parameters<typeof account.signTypedData>[0],
      );
      return ok({ signature });
    } catch (e) {
      return err({
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }
  };

  return {
    async provisionWallet(userRef) {
      const walletId = `mock-${keccak256(toHex(userRef)).slice(2, 18)}`;
      return ok({ walletId, address: account.address });
    },
    async getWalletStatus() {
      // Mock wallets are deterministic and never deleted out-of-band.
      return ok("active" as const);
    },
    signOrder: sign,
    signClobAuth: sign,
    async sendTransaction(req: SendTransactionRequest) {
      // The mock never broadcasts; it returns a deterministic pseudo tx hash so the
      // allowance-bootstrap path can be exercised end-to-end without a chain.
      const txHash = keccak256(toHex(`${req.wallet.walletId}:${req.to}:${req.data}`));
      return ok({ txHash });
    },
  };
};
