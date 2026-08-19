# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# Tarmoto companion container image (Next.js standalone), shaped after
# tabletap's PWA image (Studio81Labs/tabletap apps/pwa/Dockerfile) with this
# repo's conventions from apps/backend/Dockerfile.
#
# Built by Coolify off `main` (Dockerfile build pack, repo-root context).
# Also runnable locally (`docker build -f apps/companion/Dockerfile .`).
#
# Base image and pnpm are hardcoded (not parameterised via ARG) because
# Coolify auto-injects every application env var as a build ARG — a stray
# NODE_VERSION in the app's Coolify config would silently switch the base.
# The pnpm pin is kept in lockstep with the root `packageManager` field.
#
# BUILD-TIME configuration (Coolify Build Variables — baked into the bundle,
# cannot change at runtime):
#   TARMOTO_API_URL          required — backend origin, e.g. https://api-staging.tarmoto.app
#   TARMOTO_WS_URL           required — websocket origin, e.g. wss://api-staging.tarmoto.app
#   TARMOTO_SITE_URL         optional — canonical site origin for absolute URLs
#   TARMOTO_MAP_STYLE_URL    optional — MapLibre style URL (defaults to OpenFreeMap liberty)
#   TARMOTO_AERIAL_TILES_URL optional — aerial XYZ template (defaults to ČÚZK ortofoto)
#   TARMOTO_APP_VERSION / TARMOTO_APP_BUILD — stamped by companion-deploy.yml
#
# RUNTIME configuration (Coolify env, never build args — a secret passed as a
# build ARG persists in image layers): AUTH_SECRET, AUTH_URL, AUTH_GOOGLE_ID,
# AUTH_GOOGLE_SECRET, AUTH_APPLE_ID, AUTH_APPLE_SECRET.

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
# ca-certificates: `next build` downloads the next/font/google families over
# TLS at build time; without trust roots the build dies resolving fonts.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# ---------- build ----------
FROM base AS build
WORKDIR /repo

# Manifests first so `pnpm fetch` caches by lockfile alone. Every workspace
# project's manifest is copied because the frozen lockfile records the whole
# importer graph; the FILTERED install below still only materialises the
# companion's subtree. `patches/` must be present for install: the lockfile
# pins patchedDependencies hashes (react-native-* — mobile-only, but the
# lockfile is validated whole).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches ./patches
COPY apps/admin/package.json apps/admin/
COPY apps/backend/package.json apps/backend/
COPY apps/companion/package.json apps/companion/
COPY apps/ingest/package.json apps/ingest/
COPY apps/marketing/package.json apps/marketing/
COPY apps/mobile/package.json apps/mobile/
COPY apps/poc-sensor/package.json apps/poc-sensor/
COPY apps/ui-preview/package.json apps/ui-preview/
COPY packages/ingest/package.json packages/ingest/
COPY packages/openapi/package.json packages/openapi/
COPY packages/openapi-client/package.json packages/openapi-client/
COPY packages/poi-db/package.json packages/poi-db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
# `pnpm fetch` has no --filter — it warms the store for the whole lockfile;
# the filtered install below is what keeps node_modules to the companion's
# subtree.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile --filter @tarmoto/companion...

# @tarmoto/shared resolves to dist/ (unlike @tarmoto/ui and
# @tarmoto/openapi-client, which the app consumes from source; the generated
# OpenAPI client is COMMITTED and freshness-gated in CI, so no codegen runs
# here — the committed client IS the contract).
RUN pnpm --filter @tarmoto/shared build

ARG TARMOTO_API_URL
ENV NEXT_PUBLIC_API_URL=$TARMOTO_API_URL
ARG TARMOTO_WS_URL
ENV NEXT_PUBLIC_WS_URL=$TARMOTO_WS_URL
ARG TARMOTO_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$TARMOTO_SITE_URL
ARG TARMOTO_MAP_STYLE_URL
ENV NEXT_PUBLIC_MAP_STYLE_URL=$TARMOTO_MAP_STYLE_URL
ARG TARMOTO_AERIAL_TILES_URL
ENV NEXT_PUBLIC_AERIAL_TILES_URL=$TARMOTO_AERIAL_TILES_URL
ARG TARMOTO_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$TARMOTO_APP_VERSION
ARG TARMOTO_APP_BUILD
ENV NEXT_PUBLIC_APP_BUILD=$TARMOTO_APP_BUILD

# Fail the build fast on a missing/garbled API or WS origin rather than
# baking a bundle that points at nothing — a wrong value here renders fine
# and breaks only at runtime, which is the expensive place to find out.
RUN node -e "for (const [name, proto] of [['NEXT_PUBLIC_API_URL', /^https?:$/], ['NEXT_PUBLIC_WS_URL', /^wss?:$/]]) { const v = process.env[name]; let u; try { u = new URL(v); } catch { u = null; } if (!u || !proto.test(u.protocol)) { console.error(name + ' must be an absolute URL (got: ' + JSON.stringify(v) + '). Set the TARMOTO_* Build Variables on the Coolify application.'); process.exit(1); } }"

RUN pnpm --filter @tarmoto/companion build

# ---------- runtime ----------
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/companion/.next/standalone ./
COPY --from=build /repo/apps/companion/.next/static ./apps/companion/.next/static
COPY --from=build /repo/apps/companion/public ./apps/companion/public
EXPOSE 3000
# Node's built-in fetch keeps the slim image curl-free; /health is the
# dependency-free liveness route (the companion must report healthy even
# when the backend is down). Coolify's own health check stays disabled so
# health lives with the image, mirroring apps/backend.
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "apps/companion/server.js"]
