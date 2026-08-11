# syntax=docker/dockerfile:1.26
#
# Tarmoto POI ingestion service (apps/ingest) — the always-on NestJS worker that
# owns the POI write path: the `poi.import` BullMQ worker + weekly scheduler +
# POI-DB migrations. Replaces BOTH the backend worker's poi-import role AND the
# retired apps/backend/Dockerfile.poi-refresh (its osmium/duckdb provisioning +
# uid/gid 100/101 fold in here). The heavy EXTRACT stays a Coolify scheduled
# `docker exec` of dist/scripts/refresh-*.js into this running container.
#
# DEBIAN (node:24-slim), not Alpine: Alpine ships only libosmium, not the
# `osmium` CLI. Base + pnpm are hardcoded (the PaaS auto-injects env as build
# ARGs; a stray NODE_VERSION/packageManager would otherwise break the build).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /workspace

# ---------- deps ----------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
# pnpm validates root patchedDependencies even when mobile is not installed.
COPY patches patches
COPY apps/ingest/package.json apps/ingest/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/poi-db/package.json packages/poi-db/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ingest packages/ingest
COPY packages/poi-db packages/poi-db
COPY apps/ingest apps/ingest
RUN pnpm --filter @tarmoto/shared build \
 && pnpm --filter @tarmoto/ingest build \
 && pnpm --filter @tarmoto/poi-db build \
 && pnpm --filter @tarmoto/ingest-service build

# ---------- runtime ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
# osmium-tool (OSM CLI) + a pinned duckdb 1.4.0 (FSQ Iceberg pull, >=1.4.0 for the
# REST catalog) + tini. curl is kept (not purged) because the HEALTHCHECK below
# needs it, same as apps/backend/Dockerfile; unzip removed after use; ca-certificates
# kept for TLS.
# Runtime user pinned uid 100 / gid 101 to MATCH the shared extract volume owner.
# HOME points at the user's dir so DuckDB's ~/.duckdb extension cache is writable.
RUN arch="$(dpkg --print-architecture)" \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      osmium-tool tini ca-certificates curl unzip \
 && curl -fsSL -o /tmp/duckdb.zip \
      "https://github.com/duckdb/duckdb/releases/download/v1.4.0/duckdb_cli-linux-${arch}.zip" \
 && unzip -o /tmp/duckdb.zip -d /usr/local/bin \
 && rm /tmp/duckdb.zip \
 && chmod +x /usr/local/bin/duckdb \
 && apt-get purge -y unzip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && duckdb --version \
 && groupadd -g 101 tarmoto \
 && useradd -u 100 -g 101 -m -d /home/tarmoto -s /usr/sbin/nologin tarmoto
WORKDIR /app

COPY --from=build /workspace/pnpm-workspace.yaml /workspace/package.json /workspace/pnpm-lock.yaml ./
# The production-only install reads the same root patchedDependencies config.
COPY --from=build /workspace/patches patches
COPY --from=build /workspace/apps/ingest/package.json apps/ingest/package.json
COPY --from=build /workspace/packages/shared/package.json packages/shared/package.json
COPY --from=build /workspace/packages/ingest/package.json packages/ingest/package.json
COPY --from=build /workspace/packages/poi-db/package.json packages/poi-db/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @tarmoto/ingest-service...

COPY --from=build /workspace/apps/ingest/dist apps/ingest/dist
COPY --from=build /workspace/packages/shared/dist packages/shared/dist
COPY --from=build /workspace/packages/ingest/dist packages/ingest/dist
COPY --from=build /workspace/packages/poi-db/dist packages/poi-db/dist

# Seed the extract-volume mount points owned by uid 100 so a FRESH named volume
# comes up writable (Docker copies the empty volume's owner from the image mount
# point on first mount). The OSM POI dir and the FSQ dir may be one shared path;
# the OSM ROAD dir (Sub-project B) MUST be a separate path from the POI one —
# both write per-region `<code>.osm` files, so sharing a dir would let the two
# refreshes clobber each other's extracts.
ARG TARMOTO_OSM_POI_IMPORT_DIR=/data/poi-extracts
ARG TARMOTO_FSQ_POI_IMPORT_DIR=/data/poi-extracts
ARG TARMOTO_OSM_ROAD_IMPORT_DIR=/data/road-extracts
# The ROUTING dir holds the whole-network `<code>.osm` GraphHopper imports (the
# road:refresh writes it, the backend conflation tags it) — its own path, seeded
# writable like the others so a fresh shared volume comes up owned by uid 100.
ARG TARMOTO_OSM_ROAD_ROUTING_DIR=/data/routing
RUN osm="${TARMOTO_OSM_POI_IMPORT_DIR:-/data/poi-extracts}" \
 && fsq="${TARMOTO_FSQ_POI_IMPORT_DIR:-/data/poi-extracts}" \
 && road="${TARMOTO_OSM_ROAD_IMPORT_DIR:-/data/road-extracts}" \
 && routing="${TARMOTO_OSM_ROAD_ROUTING_DIR:-/data/routing}" \
 && mkdir -p "$osm" "$fsq" "$road" "$routing" \
 && chown tarmoto:tarmoto "$osm" "$fsq" "$road" "$routing"

ENV HOME=/home/tarmoto
USER tarmoto
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD curl --fail --silent "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# Always-on worker + scheduler + POI migrations (migrationsRun applies on boot).
# The heavy EXTRACT is a scheduled `docker exec` of dist/scripts/refresh-*.js:
#   OSM (weekly):  node apps/ingest/dist/scripts/refresh-poi-extracts.js
#   FSQ (monthly): node apps/ingest/dist/scripts/refresh-fsq-extracts.js
#   Road (weekly, staggered from the POI OSM refresh):
#                  node apps/ingest/dist/scripts/refresh-road-extracts.js
CMD ["node", "apps/ingest/dist/main.js"]
