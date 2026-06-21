# Risk Register

_Last updated: 2026-06-22. Ordered with the top blocker first._

| ID | Risk | Probability | Impact | Mitigation | Trigger / Owner | Status |
|---|---|---:|---:|---|---|---|
| R-005 | **TOP BLOCKER.** Legal exposure & geoblock: Polymarket fully blocks RU, US, 35+ (IP-based, open & close); operating from / serving these jurisdictions may be unlawful or violate ToS. | High | Critical | Legal opinion before any execution/identity work; strict server-side geoblock + fail closed; read-only public-data only meanwhile (A-001) | Product / Legal / Tech | **Open — blocking** |
| R-010 | Legal/ToS exposure from hosting even the read-only product for blocked-jurisdiction users | Medium | High | Include in the A-001 legal opinion scope; document hosting region & access policy | Product / Legal | Open |
| R-009 | ERC-7739-wrapped `POLY_1271` order signing cannot be produced reliably client-side / V2 SDK behaviour differs | Medium | High | Integration spike (A-021) before Gate 4; mocks/fixtures; low-value staging wallet | Technical lead | Open |
| R-001 | Current CLOB/deposit-wallet SDK behaviour differs from documentation | Medium | High | Integration spike against current V2 SDK; verified-facts doc re-checked before Gate 4 | Technical lead | Open |
| R-003 | Conditional rule triggers on stale or gapped data | Medium | Critical | Fail closed, stale policy, snapshot recovery, single-writer, deterministic replay | Technical lead | Open |
| R-002 | Incorrect or incomplete PnL due to lifecycle operations and missing history | High | High | Explicit methodology, provenance, reconciliation vs Data API, future ledger seam | Technical lead / Product | Open |
| R-004 | Credential or signing compromise | Low/Medium | Critical | No primary key custody, encrypted L2 creds, redaction, feature flags, external review | Security owner | Open |
| R-007 | Upstream API/WebSocket instability | Medium | High | Adapter layer, reconnect, REST snapshot + WS deltas, degraded mode, monitoring | Technical lead | Open |
| R-006 | Scope expands into generic all-in-one terminal before PMF | High | High | P0/P1 boundary and decision gates enforced | Product owner | Open |
| R-008 | Infrastructure over-engineered for 50–100 users | Medium | Medium | ADR-0001 cost cap; justify every service; single VPS + managed PG | Technical lead | Open |
