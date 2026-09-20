# syntax=docker/dockerfile:1
#
# One Dockerfile for every Node service. SERVICE picks which app to run.
#
# The whole workspace is built in a single stage rather than per-service, because
# the services share five workspace packages: building them once and selecting an
# entrypoint keeps the images consistent with each other and the build simple to
# read. The cost is image size, which is the right trade for a portfolio stack.

# PRD §3 locks the runtime to Node 22 LTS.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ── dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/logger/package.json   packages/logger/
COPY packages/http/package.json     packages/http/
COPY packages/kafka/package.json    packages/kafka/
COPY packages/testkit/package.json  packages/testkit/
COPY apps/gateway/package.json      apps/gateway/
COPY apps/identity/package.json     apps/identity/
COPY apps/catalog/package.json      apps/catalog/
COPY apps/reservation/package.json  apps/reservation/
COPY apps/orders/package.json       apps/orders/
COPY apps/waitingroom/package.json  apps/waitingroom/
COPY apps/notification/package.json apps/notification/
RUN pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/
RUN pnpm -r --workspace-concurrency=1 build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ARG SERVICE
ENV SERVICE=${SERVICE}
ENV NODE_ENV=production

COPY --from=build /app /app

# Never run as root.
USER node

# Migrations run at startup and are idempotent, so a restarted container is a
# no-op rather than a failure. Services with no database of their own skip them.
CMD ["sh", "-c", "cd /app/apps/$SERVICE && if [ -d migrations ]; then pnpm exec node-pg-migrate -m migrations -j sql up; fi && node dist/index.js"]
