# ADR-0003 — Authentication and Session Design (Slice 2)

Date: 2026-06-22  
Status: **Accepted**  
Deciders: Owner (PM/BA), Senior Technical Lead

---

## Context

Slice 2 requires wallet-based identity for the closed beta. The requirements are:

- Non-custodial: backend never holds a user's primary wallet private key or seed phrase.
- Allowlist-gated: only pre-approved wallet addresses may authenticate.
- Revocable: sessions must be revocable immediately (user logout, admin action).
- Auditable: every login attempt, allowlist check, and wallet linkage must produce an audit event.

## Decision

### Sign-in mechanism: EIP-712 typed data challenge-response

The user signs a short-lived typed-data message to prove ownership of their EOA without revealing any secret. The message is human-readable in MetaMask and WalletConnect:

```
statement: "Sign in to MX2 Terminal"
nonce:     0x<16 random bytes>
issuedAt:  <ISO-8601 timestamp>
```

Domain: `{ name: "MX2 Terminal", version: "1", chainId: 137 }` (Polygon mainnet).

Server recovers the signer address via viem's `recoverTypedDataAddress`. No private key or seed phrase leaves the user's wallet at any point.

**Why EIP-712 over SIWE (EIP-4361)?** EIP-712 is simpler to implement server-side and produces the same security guarantees for a single-domain closed beta. SIWE adds structured fields (URI, version, chainId in the message body) that are useful for multi-domain SSO — not needed here.

### Session storage: DB-backed httpOnly cookies

After successful authentication, the server issues a session token:

- Token generation: `crypto.randomBytes(32)` → 64-char hex string (256 bits of entropy).
- Storage in DB: `SHA256(token)` only — raw token is never persisted.
- Cookie: `mx2_session=<raw-token>; HttpOnly; SameSite=Strict; Secure (non-dev); Path=/`.
- TTL: 7 days (configurable via `SESSION_TTL_SECONDS`).

**Why DB sessions over JWTs?** Immediate revocability. JWTs are stateless — revoking them requires a denylist (= a DB anyway). For 50–100 beta users the DB overhead is negligible and the auditability benefit is significant: every active session is visible and revocable from the DB without requiring a separate secret rotation.

### Allowlist enforcement

Allowlist check happens at `POST /api/auth/verify` only. The server queries `allowlist.is_active` for the authenticated address:

- Not present or `is_active=false` → 403.
- Present and `is_active=true` → session created.

An `allowlist.checked` audit event is emitted regardless of outcome (both allowed and denied).

Existing sessions are **not** invalidated when an address is later removed from the allowlist. Sessions expire naturally (7 days) or must be revoked explicitly. Acceptable for a controlled beta; revisit before public launch.

### Allowlist management in Slice 2

No admin API endpoint is shipped in Slice 2. Entries are managed via direct DB access (`psql INSERT INTO allowlist ...`). An admin API is deferred to a later slice when the owner approves it.

### Data API for portfolio

User positions and activity are fetched from `https://data-api.polymarket.com` using the authenticated user's EOA wallet address as the query parameter. These are **public** endpoints — no per-user CLOB credentials are required. This means positions reflect activity on **any** Polymarket frontend that has used the same wallet address, not only this terminal.

PnL is computed client-side (in the API endpoint) as:

```
unrealized PnL = sum(currentValue - initialValue)   per position
realized PnL   = sum(realizedPnl)                    per position (from API)
```

Methodology and limitations are embedded in every `/api/profile/pnl` response to prevent misleading UX.

## Alternatives considered

| Option                            | Why rejected                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| JWT sessions                      | Stateless; no immediate revocability; requires secret rotation; audit is harder.             |
| SIWE (EIP-4361)                   | Adds complexity (domain binding, version fields) not needed for a single-domain closed beta. |
| OAuth/passkey                     | No wallet integration path; does not prove Polygon address ownership.                        |
| L2 CLOB credentials for portfolio | Requires per-user encryption at rest (Slice 3); not needed for read-only Slice 2.            |

## Consequences

- **viem** is added to `apps/api` for EIP-712 address recovery (`recoverTypedDataAddress`). No wallet-sdk or ethers is introduced.
- Four new DB tables: `auth_challenges`, `users`, `sessions`, `allowlist` — migration `0002_cultured_dragon_man.sql`.
- `@fastify/cookie` (v11) added to `apps/api` for httpOnly cookie management.
- Data API URL (`https://data-api.polymarket.com`) is an **unverified** working assumption (A-042). Verify during the staging integration spike before Gate 4.
- The `SESSION_TTL_SECONDS` and session `cookieSecure` (derived from `APP_ENV`) are now part of `AppConfig`.
