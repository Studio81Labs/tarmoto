# syntax=docker/dockerfile:1.23
#
# Tarmoto backend container image.
#
# Multi-stage so the final image only carries production deps and the
# compiled `dist/`. The build stage uses pnpm with the workspace
# enabled because the backend depends on `@tarmoto/shared`.
#
# Built by the PaaS off `main` (Dockerfile build pack, repo root context).
# Also runnable locally (`docker build -f apps/backend/Dockerfile .`).
#
# Base image is hardcoded (not parameterised via ARG) because the PaaS
# auto-injects every application env var as a build ARG. A `NODE_VERSION`
# env var anywhere in the application's Coolify config — or one of its
# own internal build args — would otherwise override the default and
# the build would end up on the Debian variant of node:24, where `apk`
# doesn't exist and the runtime stage fails. Same reason for `pnpm@10`
# below. (Verified during Nexcue's Coolify migration; this defensive
# pin is mirrored here proactively.)

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /workspace

# ---------- deps ----------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/openapi/package.json packages/openapi/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @tarmoto/shared build \
 && pnpm --filter @tarmoto/backend build

# ---------- runtime ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    TARMOTO_NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate
RUN apk add --no-cache curl tini \
 && addgroup -S tarmoto && adduser -S tarmoto -G tarmoto
WORKDIR /app

COPY --from=build /workspace/pnpm-workspace.yaml /workspace/package.json /workspace/pnpm-lock.yaml ./
COPY --from=build /workspace/apps/backend/package.json apps/backend/package.json
COPY --from=build /workspace/packages/shared/package.json packages/shared/package.json
COPY --from=build /workspace/packages/openapi/package.json packages/openapi/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @tarmoto/backend...

COPY --from=build /workspace/apps/backend/dist apps/backend/dist
COPY --from=build /workspace/packages/shared/dist packages/shared/dist
COPY docs/database/ docs/database/

USER tarmoto
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD curl --fail --silent http://127.0.0.1:3000/api/v1/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Run pending TypeORM migrations before starting the server so schema
# changes ship atomically with the code that depends on them. Migrations
# are idempotent — already-applied ones are skipped.
CMD ["sh", "-c", "cd apps/backend && npx typeorm migration:run -d dist/data-source.js && cd /app && node apps/backend/dist/main.js"]
