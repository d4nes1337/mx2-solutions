import { encodeFunctionData, createPublicClient, http, getAddress, type Address } from "viem";
import { polygon } from "viem/chains";
import { ok, err, type Result } from "@mx2/core";
import type { AuditStore, PrivyWalletStore, PrivyWalletRow } from "@mx2/db";
import type { TradingSigner, TradingWalletRef, SignerError } from "@mx2/trading-signer";

/**
 * One-time, server-signed, idempotent allowance bootstrap for a Privy trading
 * wallet. Before a signatureType-0 EOA can have its CLOB orders fill, it must
 * approve USDC (ERC-20) and the CTF (ERC-1155) to the Polymarket exchanges.
 *
 * Fail-closed: callers must NOT submit an order unless the wallet is bootstrapped
 * (privy_wallets.allowances_bootstrapped_at is set). All approvals are signed via
 * the TradingSigner under Privy policy (which itself allowlists these exact
 * contracts), so the blast radius is bounded even here.
 *
 * NOTE(verify): the exact spender set (incl. the neg-risk adapter) and USDC token
 * (native vs bridged USDC.e) are pinned to Polygon mainnet below but must be
 * confirmed on staging — see docs/ASSUMPTIONS.md.
 */

// Polygon (137) contracts.
export const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged USDC.e
export const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
export const NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";

/** Exchanges that must be approved as USDC spender + CTF operator. */
export const ALLOWANCE_SPENDERS: readonly string[] = [EXCHANGE_V2, NEG_RISK_EXCHANGE_V2];

const MAX_UINT256 = 2n ** 256n - 1n;
/** Treat an allowance below this as "needs approval" (covers partial spends). */
const SUFFICIENT_ALLOWANCE = MAX_UINT256 / 2n;

const ERC20_ABI = [
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
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC1155_ABI = [
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
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Read seam so the orchestration is unit-testable without a chain. */
export interface AllowanceReader {
  erc20Allowance(token: string, owner: string, spender: string): Promise<bigint>;
  isApprovedForAll(token: string, owner: string, operator: string): Promise<boolean>;
  /** Raw token units (USDC.e = 6 decimals). Used by the wallet top-up UX. */
  erc20Balance(token: string, owner: string): Promise<bigint>;
}

/** Real reader backed by a viem public client over the configured Polygon RPC. */
export const createViemAllowanceReader = (rpcUrl: string): AllowanceReader => {
  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  return {
    async erc20Allowance(token, owner, spender) {
      return client.readContract({
        address: getAddress(token),
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [getAddress(owner), getAddress(spender)],
      });
    },
    async isApprovedForAll(token, owner, operator) {
      return client.readContract({
        address: getAddress(token),
        abi: ERC1155_ABI,
        functionName: "isApprovedForAll",
        args: [getAddress(owner), getAddress(operator)],
      });
    },
    async erc20Balance(token, owner) {
      return client.readContract({
        address: getAddress(token),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [getAddress(owner)],
      });
    },
  };
};

export interface EnsureAllowancesDeps {
  signer: TradingSigner;
  reader: AllowanceReader;
  privyWallets: PrivyWalletStore;
  auditStore: AuditStore;
}

/**
 * Ensure all required allowances exist for the wallet, signing only the missing
 * ones. Idempotent: a bootstrapped wallet returns immediately; partially-approved
 * wallets only fill the gaps. Fail-closed: any signer failure aborts and is audited.
 */
export const ensureAllowances = async (
  deps: EnsureAllowancesDeps,
  wallet: PrivyWalletRow,
): Promise<Result<{ bootstrapped: true; txHashes: string[] }, SignerError>> => {
  if (wallet.allowancesBootstrappedAt) return ok({ bootstrapped: true, txHashes: [] });

  const ref: TradingWalletRef = {
    walletId: wallet.privyWalletId,
    address: wallet.embeddedAddress,
  };
  const owner = wallet.embeddedAddress;
  const txHashes: string[] = [];

  const sendApproval = async (
    kind: "usdc" | "ctf",
    to: string,
    data: string,
    spender: string,
  ): Promise<Result<void, SignerError>> => {
    const sent = await deps.signer.sendTransaction({ wallet: ref, to, data });
    if (!sent.ok) {
      await deps.auditStore.emit({
        actor: wallet.walletAddress,
        action: "allowance.failed",
        subject: `wallet:${wallet.walletAddress}`,
        metadata: { kind, spender, error: sent.error.code, message: sent.error.message },
      });
      return err(sent.error);
    }
    txHashes.push(sent.value.txHash);
    await deps.auditStore.emit({
      actor: wallet.walletAddress,
      action: "allowance.approve.submitted",
      subject: `wallet:${wallet.walletAddress}`,
      metadata: { kind, spender, txHash: sent.value.txHash },
    });
    return ok(undefined);
  };

  for (const spender of ALLOWANCE_SPENDERS) {
    const allowance = await deps.reader.erc20Allowance(USDC_ADDRESS, owner, spender);
    if (allowance < SUFFICIENT_ALLOWANCE) {
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [getAddress(spender) as Address, MAX_UINT256],
      });
      const r = await sendApproval("usdc", USDC_ADDRESS, data, spender);
      if (!r.ok) return err(r.error);
    }

    const approved = await deps.reader.isApprovedForAll(CTF_ADDRESS, owner, spender);
    if (!approved) {
      const data = encodeFunctionData({
        abi: ERC1155_ABI,
        functionName: "setApprovalForAll",
        args: [getAddress(spender) as Address, true],
      });
      const r = await sendApproval("ctf", CTF_ADDRESS, data, spender);
      if (!r.ok) return err(r.error);
    }
  }

  await deps.privyWallets.markAllowancesBootstrapped(wallet.walletAddress);
  await deps.auditStore.emit({
    actor: wallet.walletAddress,
    action: "allowance.approve.confirmed",
    subject: `wallet:${wallet.walletAddress}`,
    metadata: { txHashes, spenders: ALLOWANCE_SPENDERS },
  });
  return ok({ bootstrapped: true, txHashes });
};
