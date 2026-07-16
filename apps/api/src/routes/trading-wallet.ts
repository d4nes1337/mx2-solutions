import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  SessionStore,
  PrivyWalletStore,
  DelegationStore,
  TradingAccountStore,
  WithdrawalStore,
} from "@mx2/db";
import {
  PUSD_ADDRESS,
  buildPusdTransfer,
  isDepositWalletConfirmed,
  type DepositWalletRelayer,
} from "@mx2/polymarket-client";
import type { TradingSigner } from "@mx2/trading-signer";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { USDC_ADDRESS, type AllowanceReader } from "../trade/allowance-bootstrap.js";
import { ensureDepositWalletAllowances } from "../trade/deposit-wallet-allowances.js";
import { ensureTradingWalletProvisioned } from "../trade/provision-wallet.js";

export interface TradingWalletRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  tradingSigner: TradingSigner;
  privyWallets: PrivyWalletStore;
  tradingAccounts: TradingAccountStore;
  delegations: DelegationStore;
  depositWalletRelayer: DepositWalletRelayer;
  withdrawals: WithdrawalStore;
  /** null when POLYGON_RPC_URL is not configured (allowance bootstrap unavailable). */
  allowanceReader: AllowanceReader | null;
}

/**
 * Withdrawal body — deliberately STRICT: a smuggled `destination` (or any
 * other key) is a 400. The destination is ALWAYS the session user's login
 * wallet, resolved server-side. That is the entire security model (R-031).
 */
const WithdrawSchema = z
  .object({
    amountUsd: z.number().positive().min(1).max(1_000_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

/**
 * Onboarding for server-side ("sign once") trading. The user:
 *  1. POST /provision  → we create a Privy-managed embedded wallet (key in Privy's
 *     enclave; we store only references). They fund it with a bounded amount.
 *  2. POST /delegate   → records their one-time consent granting the server signing
 *     authority for a bounded time (the single wallet popup happens client-side via
 *     the Privy React SDK; here we persist the delegation + expiry).
 * After that, manual orders and conditional auto-execution sign with no further popup.
 */
export const registerTradingWalletRoutes = (
  app: FastifyInstance,
  deps: TradingWalletRoutesDeps,
): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  const ensureEnabled = (reply: FastifyReply): boolean => {
    if (!deps.config.features.privySigning) {
      reply.code(503);
      void reply.send({
        error: "PRIVY_SIGNING_DISABLED",
        message: "Server-side signing is not enabled.",
      });
      return false;
    }
    return true;
  };

  const ensureRelayerEnabled = (reply: FastifyReply): boolean => {
    if (!deps.config.features.relayer || !deps.depositWalletRelayer.enabled) {
      reply.code(503);
      void reply.send({
        error: "RELAYER_DISABLED",
        message:
          "Deposit-wallet activation is not enabled on this build. External Polymarket wallets can still trade with wallet signatures.",
      });
      return false;
    }
    return true;
  };

  // ── POST /api/trading-wallet/provision ────────────────────────────────────
  app.post("/api/trading-wallet/provision", { preHandler: requireAuth }, async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const user = req.user!;

    const result = await ensureTradingWalletProvisioned(
      {
        config: deps.config,
        auditStore: deps.auditStore,
        tradingSigner: deps.tradingSigner,
        privyWallets: deps.privyWallets,
        tradingAccounts: deps.tradingAccounts,
      },
      user.walletAddress,
    );
    if (!result.ok) {
      reply.code(502);
      return { error: result.code, message: result.message };
    }

    return {
      ok: true,
      tradingAccountId: result.tradingAccountId,
      embeddedAddress: result.embeddedAddress,
      depositWalletAddress: result.depositWalletAddress,
      allowancesBootstrapped: result.allowancesBootstrapped,
      alreadyProvisioned: result.alreadyProvisioned,
      reissued: result.reissued,
      walletHealth: result.walletHealth,
      ...(result.alreadyProvisioned
        ? {}
        : {
            fundingInstructions:
              "Deposit-wallet activation is required before funding. Once active, fund the Polymarket deposit wallet, not the embedded signer EOA.",
          }),
    };
  });

  // ── POST /api/trading-wallet/reissue ──────────────────────────────────────
  // Explicit repair for a wallet deleted at the provider (e.g. via the Privy
  // dashboard). Refuses when the wallet is still alive — recreating it would
  // strand any funds its deposit wallet controls — and refuses to guess when
  // the provider can't be reached (nothing is changed in either case).
  app.post("/api/trading-wallet/reissue", { preHandler: requireAuth }, async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const user = req.user!;

    const wallet = await deps.privyWallets.find(user.walletAddress);
    if (wallet) {
      const status = await deps.tradingSigner.getWalletStatus(wallet.privyWalletId);
      if (!status.ok) {
        reply.code(502);
        return {
          error: "WALLET_VERIFY_FAILED",
          message:
            "Could not verify the trading wallet with the provider — nothing was changed. Try again shortly.",
        };
      }
      if (status.value === "active") {
        reply.code(409);
        return {
          error: "WALLET_STILL_ACTIVE",
          message:
            "Your trading wallet is still active — re-creating it would strand any funds it controls. Nothing was changed.",
        };
      }
    }

    const result = await ensureTradingWalletProvisioned(
      {
        config: deps.config,
        auditStore: deps.auditStore,
        tradingSigner: deps.tradingSigner,
        privyWallets: deps.privyWallets,
        tradingAccounts: deps.tradingAccounts,
      },
      user.walletAddress,
    );
    if (!result.ok) {
      reply.code(502);
      return { error: result.code, message: result.message };
    }

    return {
      ok: true,
      reissued: result.reissued,
      created: wallet === null,
      tradingAccountId: result.tradingAccountId,
      embeddedAddress: result.embeddedAddress,
      depositWalletAddress: result.depositWalletAddress,
      walletHealth: result.walletHealth,
    };
  });

  // ── POST /api/trading-wallet/activate-deposit-wallet ──────────────────────
  app.post(
    "/api/trading-wallet/activate-deposit-wallet",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ensureEnabled(reply)) return;
      if (!ensureRelayerEnabled(reply)) return;
      const user = req.user!;

      const wallet = await deps.privyWallets.find(user.walletAddress);
      if (!wallet) {
        reply.code(400);
        return {
          error: "TRADING_WALLET_NOT_PROVISIONED",
          message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
        };
      }

      const owner = { ownerAddress: wallet.embeddedAddress, ownerWalletId: wallet.privyWalletId };
      const currentStatus = await deps.depositWalletRelayer.getDeploymentStatus(owner);
      if (!currentStatus.ok) {
        await deps.auditStore.emit({
          actor: user.walletAddress,
          action: "trading_wallet.deposit_wallet_activation_failed",
          subject: `wallet:${user.walletAddress}`,
          metadata: {
            embeddedAddress: wallet.embeddedAddress,
            code: currentStatus.error.code,
          },
        });
        reply.code(currentStatus.error.code === "RELAYER_DISABLED" ? 503 : 502);
        return { error: currentStatus.error.code, message: currentStatus.error.message };
      }

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "trading_wallet.deposit_wallet_activation_started",
        subject: `wallet:${user.walletAddress}`,
        metadata: {
          embeddedAddress: wallet.embeddedAddress,
          depositWalletAddress: currentStatus.value.depositWalletAddress,
          alreadyDeployed: currentStatus.value.deployed,
        },
      });

      const deployment = currentStatus.value.deployed
        ? ({ ok: true, value: { ...currentStatus.value, submitted: false } } as const)
        : await deps.depositWalletRelayer.deployDepositWallet(owner);

      if (!deployment.ok) {
        await deps.auditStore.emit({
          actor: user.walletAddress,
          action: "trading_wallet.deposit_wallet_activation_failed",
          subject: `wallet:${user.walletAddress}`,
          metadata: {
            embeddedAddress: wallet.embeddedAddress,
            depositWalletAddress: currentStatus.value.depositWalletAddress,
            code: deployment.error.code,
          },
        });
        reply.code(deployment.error.code === "RELAYER_DISABLED" ? 503 : 502);
        return { error: deployment.error.code, message: deployment.error.message };
      }

      const ready = deployment.value.deployed || isDepositWalletConfirmed(deployment.value.state);
      const status = ready ? "needs_funding" : "needs_deposit_wallet";
      const account = await deps.tradingAccounts.upsertInternalPrivy({
        ownerWalletAddress: user.walletAddress,
        signerAddress: wallet.embeddedAddress,
        privyWalletId: wallet.privyWalletId,
        depositWalletAddress: deployment.value.depositWalletAddress,
        status,
        makePrimary: false,
        metadata: {
          source: "deposit_wallet_activation",
          relayerRequired: true,
          relayerDeployment: {
            state: deployment.value.state,
            submitted: deployment.value.submitted,
            transactionId: deployment.value.transactionId,
            transactionHash: deployment.value.transactionHash,
          },
        },
      });

      if (ready) {
        await deps.auditStore.emit({
          actor: user.walletAddress,
          action: "trading_wallet.deposit_wallet_activation_ready",
          subject: `trading_account:${account.id}`,
          metadata: {
            embeddedAddress: wallet.embeddedAddress,
            depositWalletAddress: deployment.value.depositWalletAddress,
            state: deployment.value.state,
            transactionId: deployment.value.transactionId,
          },
        });
      }

      return {
        ok: true,
        tradingAccountId: account.id,
        embeddedAddress: wallet.embeddedAddress,
        depositWalletAddress: deployment.value.depositWalletAddress,
        status: account.status,
        relayer: {
          submitted: deployment.value.submitted,
          deployed: ready,
          state: deployment.value.state,
          transactionId: deployment.value.transactionId,
          transactionHash: deployment.value.transactionHash,
        },
        nextAction: ready ? "top_up" : "activate_deposit_wallet",
      };
    },
  );

  // ── POST /api/trading-wallet/delegate ─────────────────────────────────────
  app.post("/api/trading-wallet/delegate", { preHandler: requireAuth }, async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const user = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const wallet = await deps.privyWallets.find(user.walletAddress);
    if (!wallet) {
      reply.code(400);
      return {
        error: "TRADING_WALLET_NOT_PROVISIONED",
        message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
      };
    }

    const ttlMs = deps.config.limits.sessionSignerTtlSeconds * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const sessionSignerId =
      typeof body["sessionSignerId"] === "string" ? body["sessionSignerId"] : null;

    await deps.delegations.create({
      walletAddress: user.walletAddress,
      sessionSignerId,
      expiresAt,
    });

    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_wallet.delegated",
      subject: `wallet:${user.walletAddress}`,
      metadata: { expiresAt: expiresAt.toISOString(), hasSessionSigner: sessionSignerId !== null },
    });

    return { ok: true, expiresAt: expiresAt.toISOString() };
  });

  // ── POST /api/trading-wallet/delegate/refresh ─────────────────────────────
  // Extends the app-side signing-authority ledger for an armed wallet WITHOUT
  // re-granting anything: refresh requires a currently ACTIVE delegation (the
  // refresh-within-grant rule, D-019). Once a delegation has lapsed the user
  // must consent again via POST /delegate. Note: if the Privy-side session
  // grant has its own shorter horizon, signing simply fails closed regardless
  // of our ledger (A-049 — verify on staging).
  app.post(
    "/api/trading-wallet/delegate/refresh",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ensureEnabled(reply)) return;
      const user = req.user!;
      const current = await deps.delegations.findActive(user.walletAddress);
      if (!current) {
        reply.code(409);
        return {
          error: "DELEGATION_NOT_ACTIVE",
          message:
            "No active signing authority to refresh — grant it again from your wallet settings.",
        };
      }
      const ttlMs = deps.config.limits.sessionSignerTtlSeconds * 1000;
      const expiresAt = new Date(Date.now() + ttlMs);
      await deps.delegations.create({
        walletAddress: user.walletAddress,
        sessionSignerId: current.sessionSignerId,
        expiresAt,
      });
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "trading_wallet.delegated",
        subject: `wallet:${user.walletAddress}`,
        metadata: {
          refreshed: true,
          expiresAt: expiresAt.toISOString(),
          hasSessionSigner: current.sessionSignerId !== null,
        },
      });
      return { ok: true, expiresAt: expiresAt.toISOString() };
    },
  );

  // ── GET /api/trading-wallet ───────────────────────────────────────────────
  // Pass ?verify=1 to also check the wallet still exists at the provider
  // (walletHealth: ok | missing | unknown). Off by default so routine status
  // polling never hammers the provider API.
  app.get("/api/trading-wallet", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const wallet = await deps.privyWallets.find(user.walletAddress);
    const delegation = wallet ? await deps.delegations.findActive(user.walletAddress) : null;
    const internalAccount = wallet
      ? (await deps.tradingAccounts.listByOwner(user.walletAddress)).find(
          (account) =>
            account.kind === "internal_privy" &&
            account.signerAddress.toLowerCase() === wallet.embeddedAddress.toLowerCase(),
        )
      : null;

    const wantsVerify = (req.query as Record<string, unknown>)["verify"] === "1";
    let walletHealth: "ok" | "missing" | "unknown" | null = null;
    if (wantsVerify && wallet) {
      const status = await deps.tradingSigner.getWalletStatus(wallet.privyWalletId);
      walletHealth = !status.ok ? "unknown" : status.value === "active" ? "ok" : "missing";
    }

    return {
      privySigningEnabled: deps.config.features.privySigning,
      relayerEnabled: deps.config.features.relayer && deps.depositWalletRelayer.enabled,
      // NOTE: stays true even when the user archived their trading account —
      // the Privy mapping (and wallet) still exist. The UI keys restore and
      // health-check affordances off this, not off visible accounts.
      provisioned: wallet !== null,
      embeddedAddress: wallet?.embeddedAddress ?? null,
      tradingAccountId: internalAccount?.id ?? null,
      tradingAccountStatus: internalAccount?.status ?? null,
      depositWalletAddress: internalAccount?.depositWalletAddress ?? null,
      allowancesBootstrapped: wallet?.allowancesBootstrappedAt != null,
      delegationActive: delegation !== null,
      delegationExpiresAt: delegation?.expiresAt.toISOString() ?? null,
      walletHealth,
    };
  });

  // ── POST /api/trading-wallet/withdraw ─────────────────────────────────────
  // Owner-only withdrawal: USDC.e moves from the deposit wallet to the SESSION
  // user's login wallet, gaslessly, via the relayer batch. The destination is
  // never client input; the flag chain is fail-closed (withdraw → relayer →
  // privy signing + builder creds); every state change is audited.
  app.post("/api/trading-wallet/withdraw", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    if (!deps.config.features.walletWithdraw) {
      reply.code(503);
      return {
        error: "WALLET_WITHDRAW_DISABLED",
        message: "Withdrawals are not enabled on this build.",
      };
    }
    if (!ensureRelayerEnabled(reply)) return reply;
    if (!deps.allowanceReader) {
      reply.code(503);
      return {
        error: "BALANCE_UNAVAILABLE",
        message: "No Polygon RPC configured — cannot verify the withdrawable balance.",
      };
    }

    const parsed = WithdrawSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    const { amountUsd, idempotencyKey } = parsed.data;

    const wallet = await deps.privyWallets.find(user.walletAddress);
    if (!wallet) {
      reply.code(400);
      return {
        error: "TRADING_WALLET_NOT_PROVISIONED",
        message: "No trading wallet exists for this account.",
      };
    }
    const accounts = await deps.tradingAccounts.listByOwner(user.walletAddress);
    const internal = accounts.find(
      (a) =>
        a.kind === "internal_privy" &&
        a.signerAddress.toLowerCase() === wallet.embeddedAddress.toLowerCase() &&
        a.depositWalletAddress,
    );
    if (!internal?.depositWalletAddress) {
      reply.code(409);
      return {
        error: "DEPOSIT_WALLET_REQUIRED",
        message: "Activate the deposit wallet before withdrawing.",
      };
    }
    const owner = { ownerAddress: wallet.embeddedAddress, ownerWalletId: wallet.privyWalletId };
    const deployment = await deps.depositWalletRelayer.getDeploymentStatus(owner);
    if (!deployment.ok || !deployment.value.deployed) {
      reply.code(409);
      return {
        error: "DEPOSIT_WALLET_REQUIRED",
        message: "The deposit wallet is not confirmed on-chain yet.",
      };
    }

    // Destination: the session login wallet. Never a request parameter.
    const destination = user.walletAddress;

    // Deposit wallets hold pUSD, not USDC.e (INTEGRATION_VERIFIED §23).
    const balanceRaw = await deps.allowanceReader.erc20Balance(
      PUSD_ADDRESS,
      internal.depositWalletAddress,
    );
    const availableUsd = Number(balanceRaw) / 1e6;
    if (amountUsd > availableUsd) {
      reply.code(400);
      return {
        error: "INSUFFICIENT_BALANCE",
        message: `Withdrawal exceeds the deposit wallet's balance.`,
        availableUsd,
      };
    }

    const row = await deps.withdrawals.create({
      walletAddress: user.walletAddress,
      depositWalletAddress: internal.depositWalletAddress,
      destinationAddress: destination,
      amountUsd,
      idempotencyKey,
    });
    if (!row) {
      // Same idempotency key seen before — report the existing state, never
      // re-submit to the relayer.
      const existing = await deps.withdrawals.findByIdempotencyKey(
        user.walletAddress,
        idempotencyKey,
      );
      return { ok: true, alreadySubmitted: true, withdrawal: existing };
    }

    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "wallet.withdraw.requested",
      subject: `withdrawal:${row.id}`,
      metadata: {
        amountUsd,
        destination,
        depositWalletAddress: internal.depositWalletAddress,
      },
    });

    const batch = await deps.depositWalletRelayer.executeBatch(owner, [
      buildPusdTransfer({ to: destination, amountUsd }),
    ]);
    if (!batch.ok) {
      await deps.withdrawals.updateState(row.id, { state: "failed", error: batch.error.code });
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "wallet.withdraw.failed",
        subject: `withdrawal:${row.id}`,
        metadata: { amountUsd, destination, error: batch.error.code },
      });
      reply.code(502);
      return { error: batch.error.code, message: batch.error.message };
    }

    await deps.withdrawals.updateState(row.id, {
      state: isDepositWalletConfirmed(batch.value.state) ? "confirmed" : "submitted",
      relayerTransactionId: batch.value.transactionId,
      ...(batch.value.transactionHash ? { transactionHash: batch.value.transactionHash } : {}),
    });
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "wallet.withdraw.submitted",
      subject: `withdrawal:${row.id}`,
      metadata: {
        amountUsd,
        destination,
        relayerTransactionId: batch.value.transactionId,
        state: batch.value.state,
      },
    });

    return {
      ok: true,
      withdrawalId: row.id,
      destination,
      amountUsd,
      relayer: {
        transactionId: batch.value.transactionId,
        state: batch.value.state,
        ...(batch.value.transactionHash ? { transactionHash: batch.value.transactionHash } : {}),
      },
    };
  });

  // ── GET /api/trading-wallet/withdrawals ───────────────────────────────────
  // Withdrawal history for the Funds sheet. Best-effort: refreshes the state
  // of still-pending rows from the relayer (failures keep the stored state).
  app.get("/api/trading-wallet/withdrawals", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const rows = await deps.withdrawals.listByWallet(user.walletAddress, 50);

    const wallet = await deps.privyWallets.find(user.walletAddress);
    if (wallet && deps.depositWalletRelayer.enabled) {
      const owner = { ownerAddress: wallet.embeddedAddress, ownerWalletId: wallet.privyWalletId };
      for (const row of rows) {
        if (row.state !== "submitted" || !row.relayerTransactionId) continue;
        const state = await deps.depositWalletRelayer.getTransactionState(
          owner,
          row.relayerTransactionId,
        );
        if (state.ok && isDepositWalletConfirmed(state.value.state)) {
          await deps.withdrawals.updateState(row.id, {
            state: "confirmed",
            ...(state.value.transactionHash
              ? { transactionHash: state.value.transactionHash }
              : {}),
          });
          row.state = "confirmed";
          if (state.value.transactionHash) row.transactionHash = state.value.transactionHash;
        }
      }
    }

    return {
      withdrawals: rows.map((r) => ({
        id: r.id,
        amountUsd: Number(r.amountUsd),
        destination: r.destinationAddress,
        state: r.state,
        transactionHash: r.transactionHash,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // ── GET /api/trading-wallet/balance ───────────────────────────────────────
  // On-chain balances for the Funds sheet. Deposit wallets hold pUSD (the V2
  // exchanges' collateral, 1:1 USD — INTEGRATION_VERIFIED §23); raw USDC.e is
  // reported separately as "unconverted" (Polymarket converts deposits, so a
  // non-zero value means conversion is still pending). Requires a Polygon RPC;
  // without one the endpoint reports unavailable rather than guessing.
  app.get("/api/trading-wallet/balance", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    if (!deps.allowanceReader) {
      reply.code(503);
      return {
        error: "BALANCE_UNAVAILABLE",
        message: "Balance lookups are not configured on this server.",
      };
    }
    const wallet = await deps.privyWallets.find(user.walletAddress);
    if (!wallet) {
      reply.code(400);
      return {
        error: "TRADING_WALLET_NOT_PROVISIONED",
        message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
      };
    }
    const internalAccount = (await deps.tradingAccounts.listByOwner(user.walletAddress)).find(
      (account) =>
        account.kind === "internal_privy" &&
        account.signerAddress.toLowerCase() === wallet.embeddedAddress.toLowerCase(),
    );
    const depositWallet = internalAccount?.depositWalletAddress ?? null;
    const toUsd = (raw: bigint) => Number(raw) / 1e6; // pUSD and USDC.e are both 6-decimal
    const [embeddedRaw, depositPusdRaw, depositUsdcRaw] = await Promise.all([
      deps.allowanceReader.erc20Balance(USDC_ADDRESS, wallet.embeddedAddress),
      depositWallet
        ? deps.allowanceReader.erc20Balance(PUSD_ADDRESS, depositWallet)
        : Promise.resolve<bigint | null>(null),
      depositWallet
        ? deps.allowanceReader.erc20Balance(USDC_ADDRESS, depositWallet)
        : Promise.resolve<bigint | null>(null),
    ]);
    return {
      depositWalletAddress: depositWallet,
      /** pUSD — the spendable/withdrawable Polymarket balance. */
      depositWalletUsdc: depositPusdRaw === null ? null : toUsd(depositPusdRaw),
      /** Raw USDC.e still sitting in the deposit wallet (conversion pending). */
      depositWalletUnconvertedUsdc: depositUsdcRaw === null ? null : toUsd(depositUsdcRaw),
      embeddedAddress: wallet.embeddedAddress,
      embeddedUsdc: toUsd(embeddedRaw),
      asOf: new Date().toISOString(),
    };
  });

  // ── POST /api/trading-wallet/bootstrap-allowances ─────────────────────────
  // pUSD + CTF approvals FROM the deposit wallet to the Polymarket V2
  // exchanges/adapters, executed as one gasless relayer batch (W2). The chain
  // is the source of truth: only missing grants are submitted, so re-running
  // is always safe. Fail-closed: orders are refused until this reports clean.
  app.post(
    "/api/trading-wallet/bootstrap-allowances",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ensureEnabled(reply)) return;
      if (!ensureRelayerEnabled(reply)) return;
      const user = req.user!;
      if (!deps.allowanceReader) {
        reply.code(503);
        return {
          error: "ALLOWANCE_READS_UNAVAILABLE",
          message: "No Polygon RPC configured — cannot verify on-chain allowances.",
        };
      }
      const wallet = await deps.privyWallets.find(user.walletAddress);
      if (!wallet) {
        reply.code(400);
        return {
          error: "TRADING_WALLET_NOT_PROVISIONED",
          message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
        };
      }
      const internal = (await deps.tradingAccounts.listByOwner(user.walletAddress)).find(
        (a) =>
          a.kind === "internal_privy" &&
          a.signerAddress.toLowerCase() === wallet.embeddedAddress.toLowerCase() &&
          a.depositWalletAddress,
      );
      if (!internal?.depositWalletAddress) {
        reply.code(409);
        return {
          error: "DEPOSIT_WALLET_REQUIRED",
          message:
            "Activate the deposit wallet first (POST /api/trading-wallet/activate-deposit-wallet). Allowances are granted from the deposit wallet, not the signer EOA.",
        };
      }

      const result = await ensureDepositWalletAllowances(
        {
          config: deps.config,
          reader: deps.allowanceReader,
          depositWalletRelayer: deps.depositWalletRelayer,
          auditStore: deps.auditStore,
        },
        {
          userWalletAddress: user.walletAddress,
          owner: { ownerAddress: wallet.embeddedAddress, ownerWalletId: wallet.privyWalletId },
          depositWalletAddress: internal.depositWalletAddress,
        },
      );
      if (!result.ok) {
        reply.code(result.error.code === "RELAYER_DISABLED" ? 503 : 502);
        return { error: result.error.code, message: result.error.message };
      }

      // The legacy flag exists for the UI ("allowancesBootstrapped"); the
      // authoritative check stays on-chain. Mark it once the batch is away.
      if (!wallet.allowancesBootstrappedAt) {
        await deps.privyWallets.markAllowancesBootstrapped(user.walletAddress);
      }
      return {
        ok: true,
        depositWalletAddress: internal.depositWalletAddress,
        alreadyBootstrapped: result.value.alreadyBootstrapped,
        submitted: result.value.submitted,
        ...(result.value.relayerTransactionId
          ? {
              relayer: {
                transactionId: result.value.relayerTransactionId,
                state: result.value.state,
                ...(result.value.transactionHash
                  ? { transactionHash: result.value.transactionHash }
                  : {}),
              },
            }
          : {}),
      };
    },
  );

  // ── POST /api/trading-wallet/revoke ───────────────────────────────────────
  app.post("/api/trading-wallet/revoke", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    await deps.delegations.revoke(user.walletAddress);
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_wallet.revoked",
      subject: `wallet:${user.walletAddress}`,
      metadata: {},
    });
    return { ok: true };
  });
};
