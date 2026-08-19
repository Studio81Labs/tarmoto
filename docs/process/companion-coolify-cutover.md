# Companion → Coolify cutover

The companion ships as a Next.js standalone container on Coolify (same model
as the backend and ingest apps; tabletap's PWA is the sibling precedent). CI
never builds the image — Coolify builds `apps/companion/Dockerfile` from the
repo, and `companion-deploy.yml` stamps the version, triggers the deploy over
the authenticated Coolify API, tracks the deployment id, and verifies the
result. This runbook is the one-time enablement; day-2 operation needs none
of it.

## 1. Create the Coolify applications (staging + production)

For each environment on the Coolify instance (`COOLIFY_API_BASE_URL` repo
var, currently https://alpha.studio81.cz):

- New application → this repository, branch `main`, **Dockerfile build pack**,
  build context = repository root, Dockerfile `apps/companion/Dockerfile`.
- Port 3000. Leave Coolify's own health check **disabled** — health lives in
  the image (`HEALTHCHECK` → `/health`), mirroring `apps/backend`.
- **Auto Deploy OFF.** CI is the only trigger, same as every other surface.
- Domain: `app-staging.tarmoto.app` (staging) / `app.tarmoto.app`
  (production) — or the chosen names; whatever is set here must equal the
  `COMPANION_URL` GitHub variable below. HTTPS via the usual Coolify
  proxy/Let's Encrypt flow.

## 2. Application environment on Coolify

Build-time (Coolify passes application envs to the Dockerfile as build args;
these are baked into the bundle):

| Key                        | staging                           | production                |
| -------------------------- | --------------------------------- | ------------------------- |
| `TARMOTO_API_URL`          | `https://api-staging.tarmoto.app` | `https://api.tarmoto.app` |
| `TARMOTO_WS_URL`           | `wss://api-staging.tarmoto.app`   | `wss://api.tarmoto.app`   |
| `TARMOTO_SITE_URL`         | the companion origin              | the companion origin      |
| `TARMOTO_MAP_STYLE_URL`    | optional (OpenFreeMap default)    | optional                  |
| `TARMOTO_AERIAL_TILES_URL` | optional (ČÚZK default)           | optional                  |

`TARMOTO_APP_VERSION` / `TARMOTO_APP_BUILD` are stamped by CI before every
deploy — do not set them by hand.

Runtime-only (never build args — a secret passed as a build arg persists in
image layers):

| Key                                     | Notes                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AUTH_SECRET`                           | NextAuth JWT secret. New host ⇒ mint a fresh one; every existing session re-logs (pre-production, accepted). |
| `AUTH_URL`                              | The public companion origin for this env. Belt-and-braces for OAuth callback derivation behind the proxy.    |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Optional — provider hidden when unset.                                                                       |
| `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET`   | Optional — provider hidden when unset.                                                                       |

Proxy requirement: the Coolify proxy must forward `X-Forwarded-Host` and
`X-Forwarded-Proto: https` (Coolify's default Traefik labels do). NextAuth
derives callback origins from them; without `X-Forwarded-Proto` the
`__Secure-` session cookie is silently dropped.

OAuth consoles: add the new callback URLs
(`https://<companion-origin>/api/auth/callback/google` and `/apple`) before
cutover.

## 3. GitHub configuration

Per environment (staging, production):

- variable `COMPANION_URL` = the public origin from step 1
- variable `COOLIFY_COMPANION_UUID` = the Coolify application uuid

Already present and reused: repo secret `COOLIFY_API_TOKEN`, repo variable
`COOLIFY_API_BASE_URL`, per-env `BACKEND_URL` (the deploy healthcheck asserts
it appears in the served CSP).

## 4. Cut over

1. Merge the hosting PR. The push to `main` deploys **staging** via
   `companion-deploy.yml`; watch the run — it fails loudly at the exact step
   that broke and prints rollback instructions.
2. Verify staging: install prompt, login (credentials + any live OAuth),
   map tiles + aerial toggle, a shared-ride page, `/health`.
3. Point DNS at Coolify if the domain previously resolved to the Cloudflare
   worker route.
4. Production ships with the next `v*` tag (or a `workflow_dispatch` choosing
   production).

## 5. Retire the Cloudflare companion worker

After both environments serve from Coolify:

- delete the `tarmoto-companion` and `tarmoto-companion-staging` Workers in
  the Cloudflare dashboard;
- delete the GitHub variables `COMPANION_WORKER_NAME` (both envs) and
  `COMPANION_WORKERS_SUBDOMAIN`, and the repo vars `NEXT_PUBLIC_API_URL` /
  `NEXT_PUBLIC_WS_URL` that only the old worker deploy read;
- Cloudflare stays in use for marketing, admin, and the PoC — only the
  companion moves.
