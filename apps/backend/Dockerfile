# syntax=docker/dockerfile:1.7
#
# Tarmoto backend container image.
#
# Multi-stage so the final image only carries production deps and the
# compiled `dist/`. The build stage uses pnpm with the workspace
# enabled because the backend depends on `@tarmoto/shared`.
#
# Built by Coolify off `main` (Dockerfile build pack, repo root context).
# Also runnable locally (`docker build -f apps/backend/Dockerfile .`).

ARG NODE_VERSION=24-alpine
ARG PNPM_VERSION=10

FROM node:${NODE_VERSION} AS base
# Re-declare ARGs after FROM so they're visible to RUN below.
# Globally-declared ARGs only flow into FROM/AS lines.
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
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
FROM node:${NODE_VERSION} AS runtime
# Same reason as the base stage — ARGs from before the first FROM
# don't reach RUN unless redeclared in each stage.
ARG PNPM_VERSION
ENV NODE_ENV=production \
    TARMOTO_NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
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
CMD ["node", "apps/backend/dist/main.js"]
