# Tarmoto operations runbook

Day-2 procedures for running Tarmoto's deployed surfaces (backend PaaS + Cloudflare).

## Deploys

Two environments per service (staging + production). Both are driven **entirely by CI** through the authenticated Coolify API — Coolify "Auto Deploy" is **OFF** on both applications, so a push never deploys via the PaaS GitHub App. What separates the environments is the **trigger ref** and the **env-scoped GitHub configuration**, not any PaaS toggle.

|                            | Staging                                                                                                                               | Production                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Trigger                    | push to `main`                                                                                                                        | push tag `v*`                       |
| GitHub Environment         | `staging`                                                                                                                             | `production`                        |
| Coolify "Auto Deploy"      | **OFF**                                                                                                                               | **OFF**                             |
| How CI deploys             | authenticated Coolify deploy API (`GET {COOLIFY_API_BASE_URL}/api/v1/deploy?uuid=<COOLIFY_BACKEND_UUID>`, `Bearer COOLIFY_API_TOKEN`) | same call, `production`-scoped UUID |
| Healthcheck + smoke target | `api-staging.tarmoto.app`                                                                                                             | `api.tarmoto.app`                   |

`workflow_dispatch` on `backend-deploy.yml` lets an operator pick either environment (the input is checked **before** the tag ref, so a dispatch from a `v*` tag selecting "staging" still deploys staging).

### What a backend deploy does

`backend-deploy.yml` (single "Deploy & verify" job, `environment:` = the resolved env):

1. **Resolve environment** — `main` push → `staging`, `v*` tag → `production`, else the dispatch input.
2. **Resolve targets** — read env-scoped `vars.BACKEND_URL` + `vars.COOLIFY_BACKEND_UUID`.
3. **Stamp version** — `scripts/ci/resolve-app-version.sh` → upsert `TARMOTO_APP_VERSION` + `TARMOTO_SENTRY_RELEASE` into the Coolify app env (`PATCH /api/v1/applications/<uuid>/envs/bulk`).
4. **Trigger deploy** — authenticated `GET /api/v1/deploy?uuid=<uuid>`; capture the deployment id.
5. **Wait** — poll `/api/v1/deployments/applications/<uuid>` for that deployment id until `finished` (do **not** trust `/healthz` alone — the old container serves 200 during the rolling update).
6. **Healthcheck + smoke** — `/api/v1/healthz` then `scripts/smoke/smoke.sh`.
7. **On failure** — surface **manual** rollback instructions (Coolify v4 has no rollback API; there is no automated rollback).

### Releasing to production

1. Verify `main` is healthy on staging — the Backend Deploy run for the head of `main` should be green and `api-staging.tarmoto.app/api/v1/healthz` should return 200.
2. Cut a tag from `main`:
   ```bash
   git fetch origin
   git tag -a v0.X.Y origin/main -m "Release v0.X.Y"
   git push origin v0.X.Y
   ```
3. The tag push runs `backend-deploy.yml` with the `production` environment → stamps the version → triggers the Coolify deploy API → tracks the deployment to `finished` → healthcheck against `api.tarmoto.app` → `scripts/smoke/smoke.sh`.
4. The same `v*` tag fans out to every surface: `companion-deploy.yml` and `marketing-deploy.yml` resolve the `production` target on `v*`, and `mobile-release.yml` builds + submits the app to TestFlight / Play Internal (deriving the version from the tag). One tag ships backend, companion, marketing, and mobile at the same commit. Accepted tradeoff: a `v*` tag rebuilds mobile too — for a server-only hotfix, use `workflow_dispatch` on the specific deploy instead of cutting a tag.

### Verifying the staging/production split

Both apps have Auto Deploy OFF, so the split is enforced by the trigger ref + env-scoped GitHub config. After any PaaS upgrade, app re-creation, or restore from backup:

1. Push a no-op commit to a feature branch, merge to `main`, watch GitHub Actions:
   - **Backend Deploy** fires; the "Resolve environment" step outputs `name=staging`.
   - "Resolve env-specific deploy targets" resolves the **staging** `BACKEND_URL` / `COOLIFY_BACKEND_UUID`.
   - The Coolify deployment targets the **staging** app UUID; healthcheck/smoke hit `api-staging.tarmoto.app`.
2. Production's deploy history shows **no** new deploy from this `main` push.
3. Tag the same commit, push the tag, confirm production deploys and the smoke runs against `api.tarmoto.app`.

If a `main` push ever deploys production, check that Coolify Auto Deploy is still OFF on the production app (`Application → Advanced Settings → Deployment → Auto Deploy`) — CI must be the only trigger.

### Rollback (production)

CI does **not** roll back automatically (Coolify v4 exposes no rollback API); on failure it prints the recent deployments and these manual steps:

1. Coolify UI → Production application → **Deployments**.
2. Find the last known-good deployment (one before the bad one).
3. Click **Redeploy** on that row.
4. Watch the deploy logs until traffic switches; verify `api.tarmoto.app/api/v1/healthz` returns 200.
5. Run `scripts/smoke/smoke.sh https://api.tarmoto.app` locally as a final check.

### Required GitHub Secrets / Variables

Per `.github/workflows/backend-deploy.yml`:

**Repo-level secret:**

- `COOLIFY_API_TOKEN` — authenticates the deploy trigger, version-env stamping, and deploy-status polling (issued from the Coolify dashboard).

**Repo-level variable:**

- `COOLIFY_API_BASE_URL` — base URL of the Coolify API (no trailing slash).

**Per-environment variables (`staging` / `production` GitHub Environments):**

- `BACKEND_URL` — the environment's backend origin (`https://api-staging.tarmoto.app` / `https://api.tarmoto.app`).
- `COOLIFY_BACKEND_UUID` — the backend app's Coolify UUID for that environment.
