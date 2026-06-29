import { ok, err } from "@mx2/core";
import type { TradingSigner, SignerError, Eip712TypedData } from "./types.js";

/**
 * Minimal surface of the Privy server SDK that this adapter needs. We depend on
 * this narrow interface rather than importing `@privy-io/node` directly so that:
 *  - the third-party surface is isolated to a single, auditable seam,
 *  - the adapter is unit-testable with a fake client, and
 *  - the live wiring (privy-client.ts) is swappable without touching call sites.
 *
 * The concrete implementation (createRealPrivyClient) is backed by `@privy-io/node`
 * (`wallets.create()` + `createViemAccount(...).signTypedData()`), authorized with the
 * app's authorization key. Signing happens inside Privy's secure enclave; the raw key
 * is never returned here.
 */
export interface PrivySigningClient {
  createWallet(params: { chainType: "ethereum"; ownerUserId?: string }): Promise<{
    id: string;
    address: string;
  }>;
  signTypedData(params: {
    walletId: string;
    address: string;
    typedData: Eip712TypedData;
  }): Promise<{ signature: string }>;
  sendTransaction(params: {
    walletId: string;
    address: string;
    to: string;
    data: string;
    value?: string;
  }): Promise<{ txHash: string }>;
}

const mapError = (e: unknown): SignerError => {
  const message = e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();
  let code: SignerError["code"] = "UPSTREAM_ERROR";
  if (lower.includes("policy")) code = "POLICY_DENIED";
  else if (lower.includes("expired") || lower.includes("session")) code = "DELEGATION_EXPIRED";
  else if (lower.includes("unauthorized") || lower.includes("401")) code = "UNAUTHORIZED";
  else if (lower.includes("network") || lower.includes("fetch") || lower.includes("timeout"))
    code = "NETWORK_ERROR";
  return { code, message, cause: e };
};

export const createPrivyTradingSigner = (client: PrivySigningClient): TradingSigner => ({
  async provisionWallet(userRef) {
    try {
      const w = await client.createWallet({ chainType: "ethereum", ownerUserId: userRef });
      return ok({ walletId: w.id, address: w.address });
    } catch (e) {
      return err(mapError(e));
    }
  },
  async signOrder(req) {
    try {
      const { signature } = await client.signTypedData({
        walletId: req.wallet.walletId,
        address: req.wallet.address,
        typedData: req.typedData,
      });
      return ok({ signature });
    } catch (e) {
      return err(mapError(e));
    }
  },
  async signClobAuth(req) {
    try {
      const { signature } = await client.signTypedData({
        walletId: req.wallet.walletId,
        address: req.wallet.address,
        typedData: req.typedData,
      });
      return ok({ signature });
    } catch (e) {
      return err(mapError(e));
    }
  },
  async sendTransaction(req) {
    try {
      const { txHash } = await client.sendTransaction({
        walletId: req.wallet.walletId,
        address: req.wallet.address,
        to: req.to,
        data: req.data,
        ...(req.value !== undefined ? { value: req.value } : {}),
      });
      return ok({ txHash });
    } catch (e) {
      return err(mapError(e));
    }
  },
});
