import { encodeFunctionData, getAddress, type Address } from "viem";
import { ok, err, type Result } from "@mx2/core";
import type { AppConfig } from "@mx2/config";
import type { AuditStore } from "@mx2/db";
import {
  PUSD_ADDRESS,
  type DepositWalletBatchCall,
  type DepositWalletOwner,
  type DepositWalletRelayer,
  type DepositWalletRelayerError,
} from "@mx2/polymarket-client";
import {
  CTF_ADDRESS,
  EXCHANGE_V2,
  NEG_RISK_EXCHANGE_V2,
  type AllowanceReader,
} from "./allowance-bootstrap.js";

/**
 * W2 — deposit-wallet allowance bootstrap. Before the deposit wallet can be a
 * live CLOB maker (signature type POLY_1271), it must approve the collateral
 * token (pUSD — verified on-chain as the V2 exchanges' collateral, see
 * INTEGRATION_VERIFIED §23) and the CTF (ERC-1155) to the exchange/adapter
 * set. Approvals execute FROM the deposit wallet via the gasless relayer
 * batch, authorized by the embedded signer's plain EIP-712 Batch signature.
 *
 * The CHAIN is the source of truth: every call reads current allowances
 * against the deposit wallet and submits only the missing grants — no DB
 * bootstrapped flag can go stale. Fail-closed: any read/submit failure aborts
 * and is audited; callers must not enable order flow until this reports clean.
 */

export interface AllowanceSpender {
  /** Stable label used in audit metadata and the readiness panel. */
  label: string;
  address: string;
  /** Grant pUSD approve(max)? */
  collateral: boolean;
  /** Grant CTF setApprovalForAll? */
  ctf: boolean;
}

/**
 * Data-driven spender list, mirroring Polymarket's own onboarding set:
 * both V2 exchanges plus the (on-chain-verified, R-028) CTF adapters when
 * configured. Removing an unneeded grant is a one-line change here.
 */
export const depositWalletSpenders = (config: AppConfig): AllowanceSpender[] => [
  { label: "ctf_exchange_v2", address: EXCHANGE_V2, collateral: true, ctf: true },
  { label: "neg_risk_exchange_v2", address: NEG_RISK_EXCHANGE_V2, collateral: true, ctf: true },
  ...(config.ctf.adapterAddress
    ? [{ label: "ctf_adapter", address: config.ctf.adapterAddress, collateral: true, ctf: true }]
    : []),
  ...(config.ctf.negRiskAdapterAddress
    ? [
        {
          label: "neg_risk_adapter",
          address: config.ctf.negRiskAdapterAddress,
          collateral: true,
          ctf: true,
        },
      ]
    : []),
];

const MAX_UINT256 = 2n ** 256n - 1n;
/** Treat an allowance below this as "needs approval" (covers partial spends). */
const SUFFICIENT_ALLOWANCE = MAX_UINT256 / 2n;

const ERC20_APPROVE_ABI = [
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
] as const;

const ERC1155_APPROVAL_ABI = [
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
] as const;

export interface MissingGrant {
  kind: "collateral" | "ctf";
  spender: AllowanceSpender;
}

/** Pure: encode the relayer batch calls for a set of missing grants. */
export const buildDepositWalletAllowanceCalls = (
  missing: readonly MissingGrant[],
): DepositWalletBatchCall[] =>
  missing.map((grant) =>
    grant.kind === "collateral"
      ? {
          target: PUSD_ADDRESS,
          value: "0",
          data: encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: "approve",
            args: [getAddress(grant.spender.address) as Address, MAX_UINT256],
          }),
        }
      : {
          target: CTF_ADDRESS,
          value: "0",
          data: encodeFunctionData({
            abi: ERC1155_APPROVAL_ABI,
            functionName: "setApprovalForAll",
            args: [getAddress(grant.spender.address) as Address, true],
          }),
        },
  );

/** Read which grants the deposit wallet is still missing (chain = truth). */
export const findMissingGrants = async (
  reader: AllowanceReader,
  depositWalletAddress: string,
  spenders: readonly AllowanceSpender[],
): Promise<MissingGrant[]> => {
  const missing: MissingGrant[] = [];
  for (const spender of spenders) {
    if (spender.collateral) {
      const allowance = await reader.erc20Allowance(
        PUSD_ADDRESS,
        depositWalletAddress,
        spender.address,
      );
      if (allowance < SUFFICIENT_ALLOWANCE) missing.push({ kind: "collateral", spender });
    }
    if (spender.ctf) {
      const approved = await reader.isApprovedForAll(
        CTF_ADDRESS,
        depositWalletAddress,
        spender.address,
      );
      if (!approved) missing.push({ kind: "ctf", spender });
    }
  }
  return missing;
};

export interface EnsureDepositWalletAllowancesDeps {
  config: AppConfig;
  reader: AllowanceReader;
  depositWalletRelayer: DepositWalletRelayer;
  auditStore: AuditStore;
}

export interface DepositWalletAllowancesOutcome {
  /** True when the chain already had every grant — nothing was submitted. */
  alreadyBootstrapped: boolean;
  /** Labels of the grants submitted in this batch (e.g. "ctf_exchange_v2:collateral"). */
  submitted: string[];
  relayerTransactionId?: string;
  transactionHash?: string;
  state?: string;
}

/**
 * Ensure the deposit wallet holds every required allowance, submitting only
 * the missing grants as ONE relayer batch. Idempotent by construction (chain
 * reads decide); safe to re-run after a partial failure.
 */
export const ensureDepositWalletAllowances = async (
  deps: EnsureDepositWalletAllowancesDeps,
  input: {
    /** Login wallet — audit actor. */
    userWalletAddress: string;
    owner: DepositWalletOwner;
    depositWalletAddress: string;
  },
): Promise<Result<DepositWalletAllowancesOutcome, DepositWalletRelayerError>> => {
  const spenders = depositWalletSpenders(deps.config);
  const missing = await findMissingGrants(deps.reader, input.depositWalletAddress, spenders);
  if (missing.length === 0) return ok({ alreadyBootstrapped: true, submitted: [] });

  const labels = missing.map((g) => `${g.spender.label}:${g.kind}`);
  const batch = await deps.depositWalletRelayer.executeBatch(
    input.owner,
    buildDepositWalletAllowanceCalls(missing),
  );
  if (!batch.ok) {
    await deps.auditStore.emit({
      actor: input.userWalletAddress,
      action: "allowance.failed",
      subject: `wallet:${input.userWalletAddress}`,
      metadata: {
        path: "deposit_wallet",
        depositWalletAddress: input.depositWalletAddress,
        grants: labels,
        error: batch.error.code,
        message: batch.error.message,
      },
    });
    return err(batch.error);
  }

  await deps.auditStore.emit({
    actor: input.userWalletAddress,
    action: "allowance.approve.submitted",
    subject: `wallet:${input.userWalletAddress}`,
    metadata: {
      path: "deposit_wallet",
      depositWalletAddress: input.depositWalletAddress,
      grants: labels,
      relayerTransactionId: batch.value.transactionId,
      state: batch.value.state,
    },
  });

  return ok({
    alreadyBootstrapped: false,
    submitted: labels,
    relayerTransactionId: batch.value.transactionId,
    ...(batch.value.transactionHash ? { transactionHash: batch.value.transactionHash } : {}),
    state: batch.value.state,
  });
};
