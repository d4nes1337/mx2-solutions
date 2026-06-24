# ADR-0002: Wallet support and signing/authentication path

- Status: **Accepted** (Gate 1 approved 2026-06-22; live use still gated behind Gate 4)
- Date: 2026-06-22
- Decision owners: Technical Lead / Product Owner / Security owner

## Context

The terminal must be **non-custodial**: the application never holds a user's primary private key or
seed. Polymarket's recommended path for new users is the **Deposit Wallet + `POLY_1271`** model with
gasless validation via a relayer (see `docs/INTEGRATION_VERIFIED.md`). The owner chose to support
**only** this path in MVP 0.1 (EOA/legacy Safe/Proxy deferred).

## Decision

> **Correction (2026-06-23, Slice 5 / D-011):** the deposit wallet is a **Gnosis Safe** proxy and
> orders are signed with **`signatureType = 2` (POLY_GNOSIS_SAFE)**, not "sig type 3 / POLY_1271".
> The canonical CLOB enum has no type 3, and no ERC-7739 nesting is needed for type 2. The EOA signs
> the Order EIP-712 directly. See `docs/INTEGRATION_VERIFIED.md` §9–10. The "sig type 3" wording below
> is retained as the original (incorrect) record.

Support exactly one wallet path in MVP: \*\*Deposit Wallet (ERC-1967 proxy) + `POLY_1271` (sig type 3)

- relayer\*\*, via the V2 TS SDK.

### Auth & signing flow

1. **Connect + L1 auth.** User connects their owner wallet in the browser and signs an EIP-712
   challenge (L1). Backend verifies the signature, establishes a session (secure cookie, CSRF
   protection), and records the wallet address in the audit log. No private key reaches the backend.
2. **Deposit wallet derivation.** Backend derives the deterministic deposit-wallet address from the
   owner address (`deriveDepositWalletAddress`). If not deployed, deployment is a relayer
   `WALLET-CREATE` (no user signature in payload) — **gated behind the relayer feature flag and not
   in the read-only beta.**
3. **L2 credentials.** Create/derive per-user L2 creds (`apiKey`/`secret`/`passphrase`) via L1.
   Stored **server-side, encrypted at rest** with a versioned master key (KMS/secret manager).
   L2 lets the backend HMAC management/query calls; it does **not** authorise orders by itself.
4. **Order signing.** For each order: backend builds a preview (price/size/side/max spend/fees/
   funder); user confirms the economic parameters; the **wallet signs the order payload locally**
   (ERC-7739-wrapped `POLY_1271`); backend submits via the V2 client with HMAC L2 headers +
   `builderCode` + an idempotency key. funder = maker = signer = deposit wallet.
5. **Audit chain.** `intent → user signature → submission → acknowledgement → fill/cancel`,
   append-only.

## Trust boundaries

| Zone                | Holds                                                                   | Never holds                                      |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Browser + wallet    | primary private key, signs L1 challenge & order payloads                | —                                                |
| Backend             | session, encrypted per-user L2 creds, relayer key (backend-only), audit | primary private key, plaintext L2 secret in logs |
| Polymarket upstream | matches/settles orders                                                  | —                                                |

## Threat-model notes (full model: `…/docs/05`)

- **Stolen L2 creds:** damage bounded — orders still need the user's per-order signature; support
  rotation/revocation/deletion of L2 creds.
- **Compromised backend:** cannot move user funds without the user's order signature; relayer scope
  is allowlisted (wallet deploy/approvals/exec only), audited, flag-gated.
- **Replay/double-submit:** idempotency key per intent; server-side validation against the signed
  economic parameters; fail-closed on unknown submit results (reconcile before retry).
- **Secrets:** no secrets in source control; redaction in logs/traces; least privilege; documented
  deletion path. Production secrets are never shared with Claude.

## Open items (must close before Gate 4 / live)

- A-021: prove client-side ERC-7739 `POLY_1271` order signing in-browser during the integration
  spike.
- Relayer staging vs prod key separation; allowlist of target contracts/methods.
- Geo/legal opinion (A-001) — execution stays blocked until resolved.

## Product-owner approval required for

- Single-path (Deposit Wallet / POLY_1271) wallet support for MVP.
- Server-side encrypted storage of per-user L2 credentials.
- Deferral of EOA/legacy wallet paths to P1.
