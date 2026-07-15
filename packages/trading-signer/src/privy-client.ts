import { createWalletClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import type { PrivySigningClient } from "./privy-adapter.js";
import type { Eip712TypedData } from "./types.js";

/**
 * Concrete PrivySigningClient backed by `@privy-io/node`. Wallets are app-managed
 * server wallets owned by the configured key quorum; signing happens inside Privy's
 * secure enclave via the authorization key (the raw key is never returned here).
 * `createViemAccount` gives us a viem account whose `signTypedData` / transaction
 * signing is delegated to Privy — so the live path mirrors the mock exactly.
 */
export interface RealPrivyClientConfig {
  appId: string;
  appSecret: string;
  /** Base64-encoded PKCS8 P-256 authorization private key (no PEM headers). */
  authorizationPrivateKey: string;
  /** Key quorum id that owns provisioned wallets (so the authorization key can sign). */
  keyQuorumId?: string | undefined;
  /** Policy id allowlisting only Polymarket contracts (destination backstop). */
  tradingPolicyId?: string | undefined;
  /** Polygon RPC for broadcasting allowance-bootstrap transactions. */
  rpcUrl?: string | undefined;
}

// viem derives the EIP712Domain itself and rejects it being present in `types`.
const stripDomainType = (td: Eip712TypedData) => {
  const { EIP712Domain: _omit, ...types } = td.types;
  return { domain: td.domain, types, primaryType: td.primaryType, message: td.message };
};

export const createRealPrivyClient = (cfg: RealPrivyClientConfig): PrivySigningClient => {
  const privy = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
  const authorizationContext = { authorization_private_keys: [cfg.authorizationPrivateKey] };

  const accountFor = (walletId: string, address: string) =>
    createViemAccount(privy, { walletId, address: address as Hex, authorizationContext });

  return {
    async createWallet(params) {
      const wallet = await privy.wallets().create({
        chain_type: "ethereum",
        ...(cfg.keyQuorumId ? { owner_id: cfg.keyQuorumId } : {}),
        ...(cfg.tradingPolicyId ? { policy_ids: [cfg.tradingPolicyId] as never } : {}),
        ...(params.ownerUserId ? { external_id: params.ownerUserId } : {}),
      });
      return { id: wallet.id, address: wallet.address };
    },

    async getWallet(params) {
      try {
        const wallet = await privy.wallets().get(params.walletId);
        return { id: wallet.id, address: wallet.address };
      } catch (e) {
        // The SDK surfaces the HTTP status on its APIError; 404 = definitively gone.
        if ((e as { status?: unknown }).status === 404) return null;
        throw e;
      }
    },

    async signTypedData(params) {
      const account = accountFor(params.walletId, params.address);
      const signature = await account.signTypedData(
        stripDomainType(params.typedData) as Parameters<typeof account.signTypedData>[0],
      );
      return { signature };
    },

    async sendTransaction(params) {
      const account = accountFor(params.walletId, params.address);
      const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(cfg.rpcUrl),
      });
      const txHash = await walletClient.sendTransaction({
        to: params.to as Hex,
        data: params.data as Hex,
        ...(params.value ? { value: BigInt(params.value) } : {}),
      } as Parameters<typeof walletClient.sendTransaction>[0]);
      return { txHash };
    },
  };
};

const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];
const SET_APPROVAL_ABI = [
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
];

export interface CreatePolicyInput {
  appId: string;
  appSecret: string;
  usdc: string;
  ctf: string;
  exchanges: string[];
  /** EIP-712 domain chainId allowed for order/auth signing. Defaults to 137 (Polygon). */
  chainId?: number;
}

/**
 * Create the Polymarket-only wallet policy (the destination backstop). It ALLOWs only:
 *  - USDC `approve(spender ∈ exchanges)` and CTF `setApprovalForAll(operator ∈ exchanges)`,
 *  - typed-data signing on the Polygon chainId (orders + ClobAuth) — which cannot move funds.
 * Everything else — crucially `USDC.transfer` to any address — is denied by default, so funds
 * can only ever be committed to Polymarket. Validated on staging (2026-06-30): an out-of-allowlist
 * transfer is DENIED (the policy negative test passes).
 *
 * Staging-validated details — do NOT "simplify" these or the policy silently denies everything:
 *  - Transaction rules MUST target `eth_signTransaction` (viem signs via Privy and broadcasts the
 *    raw tx itself, so Privy's policy sees the SIGN method, not `eth_sendTransaction`). Both are
 *    allowed for safety across viem versions.
 *  - `ethereum_calldata` condition `field` is `functionName.argumentName` (e.g. `approve.spender`),
 *    and its address `value` must be LOWERCASE (the decoded calldata address is lowercase); the
 *    `to` (ethereum_transaction) value is the checksummed contract address.
 *  - Order/ClobAuth signing is `eth_signTypedData_v4`, scoped here to the Polygon chainId.
 */
export const createPolymarketTradingPolicy = async (
  input: CreatePolicyInput,
): Promise<{ policyId: string }> => {
  const privy = new PrivyClient({ appId: input.appId, appSecret: input.appSecret });
  const chainId = String(input.chainId ?? 137);
  const lc = (a: string): string => a.toLowerCase();
  const rules: unknown[] = [];
  for (const method of ["eth_signTransaction", "eth_sendTransaction"]) {
    for (const exchange of input.exchanges) {
      rules.push({
        name: `usdc-${method.slice(4, 8)}-${exchange.slice(2, 8)}`,
        method,
        action: "ALLOW",
        conditions: [
          { field: "to", field_source: "ethereum_transaction", operator: "eq", value: input.usdc },
          {
            field: "approve.spender",
            field_source: "ethereum_calldata",
            operator: "eq",
            value: lc(exchange),
            abi: APPROVE_ABI,
          },
        ],
      });
      rules.push({
        name: `ctf-${method.slice(4, 8)}-${exchange.slice(2, 8)}`,
        method,
        action: "ALLOW",
        conditions: [
          { field: "to", field_source: "ethereum_transaction", operator: "eq", value: input.ctf },
          {
            field: "setApprovalForAll.operator",
            field_source: "ethereum_calldata",
            operator: "eq",
            value: lc(exchange),
            abi: SET_APPROVAL_ABI,
          },
        ],
      });
    }
  }
  // Order + ClobAuth signing (typed data on Polygon). Cannot move funds (transfers stay denied).
  rules.push({
    name: "sign-typeddata",
    method: "eth_signTypedData_v4",
    action: "ALLOW",
    conditions: [
      {
        field: "chainId",
        field_source: "ethereum_typed_data_domain",
        operator: "eq",
        value: chainId,
      },
    ],
  });
  const policy = await privy.policies().create({
    name: "polymarket-trading-only",
    chain_type: "ethereum",
    version: "1.0",
    rules,
  } as never);
  return { policyId: policy.id };
};
