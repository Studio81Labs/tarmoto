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
# doesn't exist and the runtime stage fails. Same reason for `pnpm@11`
# below. (Verified during Nexcue's Coolify migration; this defensive
# pin is mirrored here proactively, and kept in lockstep with the root
# `packageManager` field.)

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
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
    PORT=3000 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
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

# Persistent POI-extract volume mount point(s) (#847 admin uploads). Each bulk
# source's admin upload writes its extract to that source's OWN configured dir
# and the import reads it back — OSM under TARMOTO_POI_IMPORT_DIR, FSQ under its
# independent TARMOTO_FSQ_IMPORT_DIR (#869) — so BOTH must be writable volumes.
# Create + chown each while still root so a FRESH named volume mounted there
# inherits that ownership (Docker copies an empty volume's owner from the image
# mount point on first mount) and the non-root runtime user can write —
# otherwise the volume comes up root-owned and uploads fail with EACCES.
#
# Seed the exact paths the deployment configures: the PaaS injects every app env
# var as a build ARG (see the base-image note above), so TARMOTO_*_IMPORT_DIR
# reach this stage. The defaults preserve the prior single-dir behaviour for a
# local `docker build`; an unset/empty FSQ dir falls back to the OSM dir (the
# common single-shared-volume topology, so seeding it twice is a harmless no-op).
# If a volume already exists root-owned, recreate it (or chown it once).
ARG TARMOTO_POI_IMPORT_DIR=/data/poi-extracts
ARG TARMOTO_FSQ_IMPORT_DIR=""
RUN poi_dir="${TARMOTO_POI_IMPORT_DIR:-/data/poi-extracts}"; \
    fsq_dir="${TARMOTO_FSQ_IMPORT_DIR:-$poi_dir}"; \
    mkdir -p "$poi_dir" "$fsq_dir" && chown tarmoto:tarmoto "$poi_dir" "$fsq_dir"

USER tarmoto
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD curl --fail --silent "http://127.0.0.1:${PORT:-3000}/api/v1/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Run pending TypeORM migrations before starting the server so schema
# changes ship atomically with the code that depends on them. Migrations
# are idempotent — already-applied ones are skipped.
CMD ["sh", "-c", "cd apps/backend && npx typeorm migration:run -d dist/data-source.js && cd /app && node apps/backend/dist/main.js"]
