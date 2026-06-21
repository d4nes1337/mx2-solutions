# Assumptions Register

Status legend: **OPEN** (needs owner/legal input) · **WORKING** (acting on it until corrected) ·
**RESOLVED**.

## Top blocker

| ID | Assumption / question | Status | Impact if wrong |
|---|---|---|---|
| A-001 | **Legal/geo:** operating a Polymarket terminal from, and serving, jurisdictions Polymarket fully blocks (RU, US, 35+) needs a legal opinion before any execution or identity work. Until then only read-only public-data work proceeds. | **OPEN — blocking** | Could make the whole execution product a no-go for the intended cohort; may also affect read-only hosting/ToS. |

## Product / scope

| ID | Assumption | Status |
|---|---|---|
| A-010 | P0/P1 boundary is exactly as written in `…/docs/02_MVP_SCOPE_ACCEPTANCE_RU.md`; no P1 feature is built without separate approval. | WORKING |
| A-011 | First external beta is **read-only** (feed, cockpit, shadow rules, simulated/illustrative PnL). Manual trading is staging-only until a separate gate. | RESOLVED (owner, 2026-06-22) |
| A-012 | Conditional rules ship **shadow/alert/manual-confirm only** in MVP 0.1. No unattended execution. | RESOLVED (doc + owner) |
| A-013 | "Beta cohort" users are crypto-native and can connect a wallet; we are not building custodial onboarding. | WORKING |

## Wallet / signing

| ID | Assumption | Status |
|---|---|---|
| A-020 | MVP supports **only** the Deposit Wallet + `POLY_1271` path via the V2 TS SDK + relayer. EOA/legacy Safe/Proxy paths are deferred. | RESOLVED (owner) |
| A-021 | The ERC-7739-wrapped `POLY_1271` order signing can be produced client-side by the V2 SDK in-browser; to be proven in the integration spike before Gate 4. | OPEN (spike) |
| A-022 | Per-user L2 CLOB creds are stored server-side encrypted (versioned master key) so the backend can HMAC L2 management/query calls. Orders still need the user's per-order signature. | WORKING |

## Architecture / ops

| ID | Assumption | Status |
|---|---|---|
| A-030 | Target stack is the TS modular monolith + worker (ADR-0001, Option A), pending Gate 1 approval. | OPEN (Gate 1) |
| A-031 | Infra target ~ EU Ireland single VPS + managed PostgreSQL, ~$120–130/mo (per `…/docs/07`). | WORKING |
| A-032 | Owner manages all secrets (encryption master key, session secret, DB password, relayer key). None are shared with Claude. | RESOLVED (doc) |
| A-033 | The 8 product brief docs stay in the gitignored inbox and are **not** committed; governance artifacts + ADRs are committed at root. | RESOLVED (owner) |

## PnL

| ID | Assumption | Status |
|---|---|---|
| A-040 | MVP PnL = realized (observed fills + redemptions) + unrealized (mark − avg cost)·size, with provenance and explicit limitations; full event-sourced ledger is P1. | WORKING |
| A-041 | Pre-onboarding history, transfers, and split/merge/redeem accounting cannot be fully reconstructed in MVP and will be labeled as such. | WORKING |
