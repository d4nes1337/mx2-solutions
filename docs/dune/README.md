# Public referral dashboard on Dune

Goal: publicly verifiable referral stats — "volume brought in per referral code" —
computed from **on-chain Polymarket fills**, not from our database. Our only
input is the referral mapping (which wallet joined with which code); the volume
numbers come from the chain, so anyone can audit them.

## How it works

1. The worker's `dune-push` job (apps/worker/src/dune-push.ts) runs daily when
   `DUNE_API_KEY` is set. It uploads a full-replace CSV table via
   `POST https://api.dune.com/api/v1/uploads/csv`:

   | column                 | meaning                                       |
   | ---------------------- | --------------------------------------------- |
   | `code`                 | referral code handle (e.g. `ANSEM`)           |
   | `owner_wallet`         | referrer EOA (empty for campaign codes)       |
   | `referee_eoa`          | referee login wallet                          |
   | `referee_proxy_wallet` | referee's Polymarket deposit wallet (derived) |
   | `redeemed_at`          | ISO timestamp of redemption                   |

   The table lands as `dune.<your_team_handle>.arima_referrals` (the namespace
   is your Dune team handle; `DUNE_TABLE_NAMESPACE` in env is only a reminder —
   the uploads API always writes into the key's own namespace).

   Privacy: the CSV contains only pseudonymous public addresses and the code
   handle. No emails, no waitlist PII, no internal ids.

2. A public Dune dashboard joins that mapping against Polymarket trade spells.
   Polymarket fills key off the **proxy wallet** (`referee_proxy_wallet`).

## Dashboard queries

> Verify the exact spellbook table names in Dune's data explorer before saving
> (search "polymarket"): the curated spell is `polymarket_polygon.market_trades`
> as of 2026-07. Column names below match that spell.

### 1. Volume per referral code (the headline table)

```sql
with referred as (
    select code, owner_wallet, referee_proxy_wallet, redeemed_at
    from dune.YOUR_TEAM.arima_referrals
)
select
    r.code,
    count(distinct r.referee_proxy_wallet)          as referees,
    sum(t.amount_usd)                               as referred_volume_usd,
    sum(case when t.block_time >= now() - interval '30' day
             then t.amount_usd end)                 as volume_30d_usd
from referred r
join polymarket_polygon.market_trades t
  on t.taker = from_hex(ltrim(r.referee_proxy_wallet, '0x'))
 and t.block_time >= r.redeemed_at        -- only volume AFTER joining counts
group by 1
order by referred_volume_usd desc;
```

### 2. Total referred volume over time (area chart)

```sql
select
    date_trunc('day', t.block_time)                 as day,
    sum(t.amount_usd)                               as volume_usd
from dune.YOUR_TEAM.arima_referrals r
join polymarket_polygon.market_trades t
  on t.taker = from_hex(ltrim(r.referee_proxy_wallet, '0x'))
 and t.block_time >= r.redeemed_at
group by 1
order by 1;
```

### 3. Signups per day (bar chart)

```sql
select date_trunc('day', redeemed_at) as day, count(*) as signups
from dune.YOUR_TEAM.arima_referrals
group by 1 order by 1;
```

Notes:

- `market_trades` rows carry both maker and taker; if you want both sides
  attributed, `union all` a second join on `t.maker`. Taker-only is the
  conservative reading (matches how most venues quote "volume").
- If the spell is missing columns on your Dune plan, the raw fallback is
  decoding `OrderFilled` events from the CTF Exchange
  (`0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e`) and NegRisk CTF Exchange on
  Polygon — ask before going down that path, the spell is much cheaper.

## One-time setup checklist (owner)

1. Create a (free) Dune account/team, mint an API key: dune.com → Settings → API.
2. Put `DUNE_API_KEY=...` into the worker's environment (secret manager — never
   in the repo). Deploy; within a minute the first push creates
   `dune.<team>.arima_referrals` (worker log: `dune_push.uploaded`).
3. In Dune: New query → paste query 1 → replace `YOUR_TEAM` → Save → make the
   query public → add to a new dashboard; repeat for queries 2–3.
4. Set the dashboard public and link it from the app/site.

## Operational notes

- Full-replace semantics: each push overwrites the table, so revoked users and
  reassigned codes are reflected automatically on the next push.
- The job is read-only against our DB and idempotent; a failed push is retried
  the next day (or restart the worker for an immediate retry).
- Rollback: unset `DUNE_API_KEY` (stops pushes) and/or
  `DELETE /api/v1/uploads/{namespace}/arima_referrals` to remove the table.
