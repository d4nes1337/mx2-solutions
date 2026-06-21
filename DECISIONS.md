# Decision Log

| ID | Date | Status | Decision | Options considered | Rationale | Owner approval |
|---|---|---|---|---|---|---|
| D-001 | 2026-06-22 | Proposed | Stack = TypeScript modular monolith + dedicated worker, PostgreSQL, single EU VPS (ADR-0001) | A: TS monolith+worker; B: Python FastAPI; C: microservices+queue | Matches official V2 TS SDK ecosystem; fastest read-only demo; fits ~$120–130/mo; clean seam to split worker later | **Pending (Gate 1)** |
| D-002 | 2026-06-22 | Approved | Wallet support = Deposit Wallet + `POLY_1271` only (ADR-0002); EOA/legacy deferred to P1 | Deposit-wallet only; EOA only; both | Polymarket's recommended new-user path; gasless; smallest correct integration surface | Owner, 2026-06-22 |
| D-003 | 2026-06-22 | Approved | Manual trading is staging-only first; not in first external beta; enabled only after a separate gate | Staging-only first; live in first beta | Lower risk; matches docs default; live needs spike + security + legal | Owner, 2026-06-22 |
| D-004 | 2026-06-22 | Open — blocking | Geo/compliance posture requires a legal opinion before execution/identity work; only read-only public-data work proceeds meanwhile | Strict fail-closed; read-only everywhere; legal-review-first | RU/US/35+ are fully blocked by Polymarket (IP-based); legal exposure unclear | **Pending legal (A-001)** |
| D-005 | 2026-06-22 | Approved | Repo layout: kit folder gitignored as private inbox; governance files + ADRs tracked at root; 8 product docs not committed | Copy governance only; also commit docs; commit nothing | Owner wants the kit as private input; governance artifacts must be version-tracked | Owner, 2026-06-22 |
