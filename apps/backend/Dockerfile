# syntax=docker/dockerfile:1.26
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
# pnpm validates root patchedDependencies even when mobile is not installed.
COPY patches patches
COPY apps/backend/package.json apps/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/poi-db/package.json packages/poi-db/package.json
COPY packages/openapi/package.json packages/openapi/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ingest packages/ingest
COPY packages/poi-db packages/poi-db
COPY apps/backend apps/backend
RUN pnpm --filter @tarmoto/shared build \
 && pnpm --filter @tarmoto/ingest build \
 && pnpm --filter @tarmoto/poi-db build \
 && pnpm --filter @tarmoto/backend build

# ---------- runtime ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
RUN apk add --no-cache curl tini \
 && addgroup -g 101 -S tarmoto && adduser -u 100 -S tarmoto -G tarmoto
WORKDIR /app

COPY --from=build /workspace/pnpm-workspace.yaml /workspace/package.json /workspace/pnpm-lock.yaml ./
# The production-only install reads the same root patchedDependencies config.
COPY --from=build /workspace/patches patches
COPY --from=build /workspace/apps/backend/package.json apps/backend/package.json
COPY --from=build /workspace/packages/shared/package.json packages/shared/package.json
COPY --from=build /workspace/packages/ingest/package.json packages/ingest/package.json
COPY --from=build /workspace/packages/poi-db/package.json packages/poi-db/package.json
COPY --from=build /workspace/packages/openapi/package.json packages/openapi/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @tarmoto/backend...

COPY --from=build /workspace/apps/backend/dist apps/backend/dist
COPY --from=build /workspace/packages/shared/dist packages/shared/dist
COPY --from=build /workspace/packages/ingest/dist packages/ingest/dist
COPY --from=build /workspace/packages/poi-db/dist packages/poi-db/dist
COPY docs/database/ docs/database/

# Persistent POI-extract volume mount point(s) (#847 admin uploads). Each bulk
# source's admin upload writes its extract to that source's OWN configured dir
# and the import reads it back — OSM under TARMOTO_OSM_POI_IMPORT_DIR, FSQ under
# its independent TARMOTO_FSQ_POI_IMPORT_DIR (#869) — so BOTH must be writable
# volumes. Also seed the OSM ROAD-extract dir (TARMOTO_OSM_ROAD_IMPORT_DIR,
# #781 Sub-project B): this image only READS it (apps/ingest's
# refresh-road-extracts, uid 100, is the writer), but the shared volume can be
# mounted by EITHER container first, so it needs the identical pre-seeded
# ownership here too — otherwise a backend-first mount leaves it root-owned and
# the ingest producer's writes fail with EACCES. Create + chown each while
# still root so a FRESH named volume mounted there inherits that ownership
# (Docker copies an empty volume's owner from the image mount point on first
# mount) and the non-root runtime user can read/write — otherwise the volume
# comes up root-owned and uploads/writes fail with EACCES.
#
# Seed the exact paths the deployment configures: the PaaS injects every app env
# var as a build ARG (see the base-image note above), so TARMOTO_*_POI_IMPORT_DIR
# and TARMOTO_OSM_ROAD_IMPORT_DIR reach this stage. The defaults preserve the
# prior single-dir behaviour for a local `docker build`; an unset/empty FSQ dir
# falls back to the OSM dir (the common single-shared-volume topology, so
# seeding it twice is a harmless no-op). If a volume already exists root-owned,
# recreate it (or chown it once).
ARG TARMOTO_OSM_POI_IMPORT_DIR=/data/poi-extracts
ARG TARMOTO_FSQ_POI_IMPORT_DIR=""
ARG TARMOTO_OSM_ROAD_IMPORT_DIR=/data/road-extracts
# The ROUTING dir holds the whole-network `<code>.osm` the quality conflation
# WRITES (its tagged `<code>.quality.osm` output) and reads — apps/ingest's
# refresh-road-extracts produces the base `.osm` there and GraphHopper imports it.
# Same shared-volume, same uid-100 ownership seeding as the extract dirs.
ARG TARMOTO_OSM_ROAD_ROUTING_DIR=/data/routing
RUN poi_dir="${TARMOTO_OSM_POI_IMPORT_DIR:-/data/poi-extracts}"; \
    fsq_dir="${TARMOTO_FSQ_POI_IMPORT_DIR:-$poi_dir}"; \
    road_dir="${TARMOTO_OSM_ROAD_IMPORT_DIR:-/data/road-extracts}"; \
    routing_dir="${TARMOTO_OSM_ROAD_ROUTING_DIR:-/data/routing}"; \
    mkdir -p "$poi_dir" "$fsq_dir" "$road_dir" "$routing_dir" && chown tarmoto:tarmoto "$poi_dir" "$fsq_dir" "$road_dir" "$routing_dir"

USER tarmoto
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD curl --fail --silent "http://127.0.0.1:${PORT:-3000}/api/v1/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Run pending TypeORM migrations before starting the server so schema
# changes ship atomically with the code that depends on them. Migrations
# are idempotent — already-applied ones are skipped.
CMD ["sh", "-c", "cd apps/backend && npx typeorm migration:run -d dist/data-source.js && cd /app && node apps/backend/dist/main.js"]
