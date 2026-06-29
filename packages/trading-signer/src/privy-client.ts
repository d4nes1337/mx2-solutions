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
}

/**
 * Create the Polymarket-only wallet policy (the destination backstop). It ALLOWs
 * only: USDC `approve(spender ∈ exchanges)` and CTF `setApprovalForAll(operator ∈
 * exchanges)`. Everything else — crucially `USDC.transfer` to any address — is
 * denied by default, so funds can only ever be committed to Polymarket. Verify on
 * staging that an out-of-allowlist transfer is rejected (the policy negative test).
 */
export const createPolymarketTradingPolicy = async (
  input: CreatePolicyInput,
): Promise<{ policyId: string }> => {
  const privy = new PrivyClient({ appId: input.appId, appSecret: input.appSecret });
  const rules = input.exchanges.flatMap((exchange) => [
    {
      name: `usdc-approve-${exchange.slice(0, 8)}`,
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions: [
        { field: "to", field_source: "ethereum_transaction", operator: "eq", value: input.usdc },
        {
          field: "spender",
          field_source: "ethereum_calldata",
          operator: "eq",
          value: exchange,
          abi: APPROVE_ABI,
        },
      ],
    },
    {
      name: `ctf-approve-${exchange.slice(0, 8)}`,
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions: [
        { field: "to", field_source: "ethereum_transaction", operator: "eq", value: input.ctf },
        {
          field: "operator",
          field_source: "ethereum_calldata",
          operator: "eq",
          value: exchange,
          abi: SET_APPROVAL_ABI,
        },
      ],
    },
  ]);
  const policy = await privy.policies().create({
    name: "polymarket-trading-only",
    chain_type: "ethereum",
    version: "1.0",
    rules,
  } as never);
  return { policyId: policy.id };
};
