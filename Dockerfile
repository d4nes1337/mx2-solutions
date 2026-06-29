# syntax=docker/dockerfile:1
# Single image for ALL services (api + worker + web). The runtime command is set
# per-service in docker-compose.prod.yml: api/worker run their dist, web runs
# `next start` from the built .next. One install + one build for the whole stack.

FROM node:20-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
# tsc -b builds every Node package + apps/api + apps/worker to dist (not apps/web).
RUN pnpm exec tsc -b
# Build the Next.js web app (apps/web/.next). NEXT_PUBLIC_* fall back to safe
# placeholders at build time; pass build args later if WalletConnect QR is wanted.
RUN pnpm --filter @mx2/web build

FROM node:20-bookworm-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
# Copy the built workspace (incl. pnpm-linked node_modules + each package's dist).
COPY --from=builder /app ./
USER node
# Default; overridden by each service's `command:` in compose.
CMD ["node", "apps/api/dist/server.js"]
