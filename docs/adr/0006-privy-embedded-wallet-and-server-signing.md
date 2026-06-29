# ADR-0006: Privy embedded wallets + server-side signing ("sign once")

- Status: Accepted (built behind flags; live enablement pending Gate 6)
- Date: 2026-06-29
- Decision owners: Technical Lead / Product Owner
- Supersedes: the trading-funds portion of ADR-0002 (browser `signatureType 2` stays for
  legacy/optional manual trading; it is no longer the path for no-popup / unattended trading)

## Context

The owner requires: sign once at login, then place orders — manual AND conditional — with no
per-order wallet popup. Polymarket's CLOB verifies an EIP-712 signature on **every** order
(L2 API creds authenticate the request but do not replace the order signature). Therefore some
key the system controls must sign each order; unattended (conditional) execution makes this
unavoidable because the user is offline. The security problem is bounding the blast radius and
protecting + auditing that key — not avoiding it.

## Decision drivers

- Never custody the user's **primary** wallet key (hard invariant, CLAUDE.md).
- Bounded, auditable blast radius; easy to debug and security-review.
- Support unattended server-side signing while the user is offline.
- Smallest production-capable change; reversible behind feature flags.

## Options considered

### Option A — Self-custodied hot wallet (server holds an encrypted EOA key)

Server generates a per-user trading EOA, stores the key AES-256-GCM encrypted, signs orders.
Works, but the raw key lives in our DB/process — the highest-value secret to steal.

### Option B — Delegate a session key on the user's existing Polymarket Safe

Keeps existing funds, but adding an owner/module to the Gnosis Safe grants full-Safe authority
(or needs a custom restricted module), requires an on-chain tx, and is hard to audit.

### Option C — Privy embedded wallets + server session signers + policy engine (chosen)

Each user gets a Privy-managed embedded EOA (the trading wallet) they fund with a bounded
amount. The user delegates signing to our backend once (Privy "delegated actions"). The server
requests signatures via Privy's server SDK; **the raw key never leaves Privy's secure enclave
(TEE)**. Privy's policy engine, enforced inside the enclave, allowlists only Polymarket
contracts so funds can never be sent to an attacker address. Trading uses `signatureType 0`
(EOA): the embedded wallet is maker = signer = funder.

## Recommendation

**Option C.** It is strictly safer than A (no raw key in our infrastructure), simpler and more
bounded than B (no Safe surgery; blast radius = the amount the user loads), and uniquely
supports offline unattended signing with in-enclave policy guardrails.

Trade-off accepted: trading funds live in a **new** Privy wallet the user funds, not their
existing MetaMask-owned Safe. The primary wallet is never touched.

## Consequences

### Positive

- Raw key never in our server (Privy TEE). Policy engine = destination backstop even if our
  backend is compromised. Bounded, user-chosen blast radius. One signing seam (`TradingSigner`)
  shared by manual + conditional paths, fully mockable → deterministic tests + live-OFF dry-run.

### Negative / risks

- New hard dependency on Privy availability for all trading (fail-closed, kill-switchable).
- App holds Privy app secret + authorization key (secrets-manager; rotation; staging≠prod).
- `signatureType 0` requires one-time USDC/CTF allowances from the embedded EOA (Slice C).
- Real `@privy-io/node` wiring + policy schema is a staging integration step (signer seam is
  done + tested via mock; Privy adapter is isolated behind a minimal injected client).

## Product-owner approval required for

- Flipping `FEATURE_PRIVY_SIGNING` (manual no-popup) and later
  `FEATURE_CONDITIONAL_LIVE_EXECUTION` (unattended) on real funds — after the RFC-0002 review
  and a low-value staging test (Gate 6).

## Validation plan

Unit + contract tests (signer seam, order builder byte-format, state machine, allowance
bootstrap, auto-executor guards) → local live-OFF dry-run with the mock signer → low-value
staging ($5–20) with a real Privy test app, including a negative test proving the policy denies
an out-of-allowlist transfer. See RFC-0002 for the full threat model + runbook.
