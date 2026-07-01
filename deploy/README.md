# Production deploy (AWS Lightsail, single box)

Topology: **one Lightsail box** runs Postgres + the API + the worker + Caddy (auto-TLS).
The **web app (Next.js) goes on Vercel's free tier** (offloads the heaviest component and
keeps the box small). Web talks to the API over HTTPS; the session cookie is cross-site
(`COOKIE_CROSS_SITE=true`).

## 1. Create the instance

- **Platform:** Linux/Unix · **Blueprint:** OS-only · **Ubuntu 22.04 LTS**
- **Size:** 2 GB RAM / 2 vCPU / 60 GB SSD (the ~$12/mo dual-stack plan) in `eu-west-1`
- Attach a **static IP**; in **Networking** open TCP **22, 80, 443**
- Add your SSH key at create time

## 2. Bootstrap + deploy

Images are built on GitHub Actions (`.github/workflows/build-and-push.yml`) and pushed to
GHCR (`ghcr.io/d4nes1337/mx2-solutions`) on every push to `main` — **the box never
compiles anything itself.** Building this monorepo's single shared image (see
`../Dockerfile`) directly on a small 2 GB box starves the live containers of
memory/CPU for the better part of an hour; GitHub's runners do the same build in
under a minute.

The GHCR package is **private**, so the box needs a pull credential once:

```bash
# On github.com: Settings → Developer settings → Personal access tokens →
# Fine-grained tokens → this repo only → Permissions → Packages: Read-only.
ssh ubuntu@<static-ip>
echo "<paste the token>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

Then bootstrap + deploy:

```bash
ssh ubuntu@<static-ip>
git clone <your-repo> mx2 && cd mx2
bash deploy/lightsail-setup.sh          # installs Docker; then log out/in
cp .env.production.example .env.production && nano .env.production   # fill secrets
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f api worker
```

Point an A record for `API_DOMAIN` at the static IP — Caddy fetches a TLS cert automatically.

## 3. Web (Vercel)

Deploy `apps/web` on Vercel. Set its API base URL to `https://<API_DOMAIN>` and set
`APP_BASE_URL` (on the box) to the Vercel URL so CORS + the cross-site cookie line up.

## 4. Going live with Privy (Gate 6)

See the runbook in `docs/rfc/0002-server-side-signing-and-unattended-execution.md` §7. In short:
create the authorization key + key quorum in the Privy dashboard, run
`pnpm --filter @mx2/api exec tsx src/scripts/bootstrap-privy-policy.ts` to create the
contract-allowlist policy, paste the ids into `.env.production`, then flip the flags in stages
after a low-value staging test (including the policy negative test).

## Operations

- **Pause trading instantly:** `curl -X POST -H "x-admin-secret: $TRADING_ADMIN_SECRET" https://<API_DOMAIN>/api/admin/trading/pause`
- **Update:** `git pull && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`
  (no `--build` — the image comes pre-built from GHCR; `git pull` is still needed for
  `docker-compose.prod.yml`/`Caddyfile`/migration-file changes, none of which require
  compiling anything on the box)
- **Backups:** snapshot the Lightsail instance + `pg_dump` the `pgdata` volume on a schedule.
