# 0006 — Deployment stack: Hetzner CX33 + Coolify (self-hosted), Cloudflare unchanged

**Status:** Proposed
**Date:** 2026-05-03
**Supersedes:** [ADR-0005](./0005-deployment-stack-render.md)

## Context

ADR-0005 was accepted-in-spirit on 2026-05-03 and committed to Render + Cloudflare with a $55/mo cost floor. That floor assumed Postgres `standard` at $19/mo — the legacy Render pricing tier.

When applying the Blueprint, Render rejected `plan: standard` with:

> `databases[0].plan`: Legacy Postgres plans, including 'standard', are no longer supported for new databases.

Render renamed Postgres plans in 2026 (e.g. `basic-4gb`, `pro-4gb`). The closest current equivalent of the deprecated `standard` is `basic-4gb` — but it's priced at **$79.50/mo**, not $19. The actual Render quote for the `infra/render/render.yaml` Blueprint was:

| Service     | Plan        | Cost           |
| ----------- | ----------- | -------------- |
| Web Service | `standard`  | $25.00         |
| Postgres    | `basic-4gb` | $79.50         |
| Key Value   | `starter`   | $10.00         |
| **Total**   |             | **$114.50/mo** |

Projected for both projects in production (Tarmoto on basic-4gb + Nexcue eventually on basic-1gb): ~$140–150/mo. ADR-0005's `~$55` floor was off by 2× and isn't recoverable by downsizing without compromising MVP-realistic DB headroom.

Meanwhile **Hetzner CX33** (4 vCPU, 8 GB RAM, 80 GB SSD, Helsinki) is **€8.46/mo** and comfortably hosts both backends + Coolify + Postgres + Redis on one box.

| Surface                       | Render (current pricing)               | Hetzner CX33 + Coolify          |
| ----------------------------- | -------------------------------------- | ------------------------------- |
| Backend container (both apps) | $50/mo (Tarmoto) + $25/mo (Nexcue)     | included                        |
| Postgres + PostGIS            | $79.50/mo (Tarmoto) + ~$15/mo (Nexcue) | included                        |
| Redis                         | $10/mo                                 | included                        |
| Object storage                | Cloudflare R2 (same)                   | Cloudflare R2 (same)            |
| TLS                           | Render auto                            | Coolify (Caddy + Let's Encrypt) |
| **Floor (both apps in prod)** | **~$140–150/mo**                       | **€8.46/mo + R2 ~€2**           |

≈ €830/year saved at MVP scale. At 24 months that's ~€1,700 — into "another small contract" territory.

## Decision

### Backend hosting: Hetzner CX33 + Coolify

- **Single VPS** running on Hetzner Cloud (CX33, Helsinki region). Public IP attached at provision time, accessible via Cloudflare DNS.
- **[Coolify](https://coolify.io/)** — open-source, self-hosted PaaS — runs as Docker on the VPS at `coolify.studio81.cz`. Provides:
  - Git-push deploys (GitHub App integration, webhook-triggered builds)
  - Managed Postgres + Redis services (backed by official upstream images, persistent volumes)
  - TLS via Caddy + Let's Encrypt (auto-renew)
  - Scheduled backups to S3-compatible targets (we use Cloudflare R2)
  - Web UI for env vars, logs, manual rollback
- **Database:** Coolify-managed PostgreSQL 17 with PostGIS via `postgis/postgis:17-3.4-alpine` image. `CREATE EXTENSION postgis` is run by the existing TypeORM migration on first deploy.
- **Cache / queue:** Coolify-managed Redis (`redis:8-alpine`), `maxmemory-policy=noeviction` for BullMQ durability.
- **Backend image:** the existing `apps/backend/Dockerfile` is unchanged — Coolify builds it the same way Render did.

### Both apps share one VPS

Tarmoto and Nexcue each get their own Coolify project on the same box. Their Postgres + Redis services are isolated (separate containers, separate volumes), but they share kernel, CPU, RAM, and disk. CX33's 8 GB RAM and 4 vCPU comfortably hosts both at MVP traffic; we'll split when traffic warrants.

### Object storage: Cloudflare R2 (unchanged)

The S3-compatible client in `apps/backend/src/modules/storage/s3-storage.ts` works against R2 with an endpoint override — same code path Render would have used. Buckets, lifecycle rules, and DNS as documented in [`docs/process/runbook.md` § "Bucket lifecycle policies (prod)"](../process/runbook.md).

### Companion: Cloudflare Workers (unchanged), PoC sensor: Cloudflare Pages (unchanged), Mobile: Fastlane (unchanged)

ADR-0005's sections for these carry over verbatim.

### Domain / DNS

Cloudflare DNS as before. Backend custom domains (`api.tarmoto.app`, eventually `api.nexcue.app`) point to the VPS public IP via A records. Cloudflare can be DNS-only or Proxied — Coolify's Caddy issues certs via direct port 80/443 challenge so either works.

### Deploys

- GitHub push to `main` → Coolify GitHub App webhook → Coolify pulls, builds the Dockerfile, deploys → ~2 min
- `.github/workflows/backend-deploy.yml` waits for Coolify deploy to report success via API, runs `scripts/smoke/smoke.sh`, and rolls back via the Coolify "redeploy previous" API on smoke failure.
- Required GitHub Secrets:
  - `COOLIFY_API_TOKEN` — for poll + rollback
  - `COOLIFY_DEPLOY_WEBHOOK_URL` — for triggering deploys when we want to bypass auto-deploy
  - `COOLIFY_APPLICATION_UUID` — identifies the Application in Coolify's API

### Backups & restore

- Coolify's Postgres backup schedule: daily `pg_dump` → R2 bucket `tarmoto-prod-backups` with 14-day retention.
- Restore drill is documented in [`docs/process/runbook.md`](../process/runbook.md) and **must be exercised once before promoting traffic** to prod.
- Volumes are local SSD on the VPS — Hetzner provides nightly snapshot for €0.0119/GB (~€0.02/mo for Tarmoto's volume), enabled out-of-band and noted in the runbook.

## Consequences

- **`infra/render/` is retained as historical reference** with a "Superseded by ADR-0006" banner. Not deleted in this PR — kept until first Coolify deploy is verified, at which point it becomes deletable in a follow-up.
- **`.github/workflows/backend-deploy.yml` is rewritten** to use Coolify's API instead of Render's. The shape (poll → smoke → rollback-on-failure) is preserved — only the API endpoints change.
- **Issue [#398](https://github.com/Studio81Labs/tarmoto/issues/398) is partially obsolete.** R2 + DNS + Stripe/OWM/FCM/APN secrets all carry over (just into Coolify env vars instead of Render env vars). The "apply Blueprint" + "Render API key" steps are dropped. Issue body to be reframed.
- **One vendor for compute (Hetzner) + one for everything else (Cloudflare).** Same vendor count as ADR-0005, swapped Render for Hetzner.
- **Single VPS = single point of failure.** One CX33 means a Hetzner DC outage takes both apps down. Mitigated by daily R2 backups + a written restore runbook + practiced restore drill. AWS multi-region was already off the table (ADR-0005); Render multi-AZ was active-active per service, also abstracted. We're not buying high availability at MVP scale; we're buying recoverability.
- **Operator responsibility:** OS security patches (Hetzner auto-applies kernel patches with reboot scheduling), Coolify upgrades (`coolify update` CLI, run monthly), backup-restore drills (quarterly).
- **No managed observability.** Coolify exposes per-service logs and basic metrics; we keep the "add Better Stack / Grafana Cloud later" stance from ADR-0005.
- **Shared RAM between Tarmoto + Nexcue.** A runaway query on one app could OOM the other. Acceptable for MVP; first sign of production traffic split, or when sustained memory pressure shows up in metrics, we add a second VPS.
- **PostgreSQL major version differs from ADR-0005:** moved from PG16 (Render-imposed) to PG17 (matching the existing `infra/docker/docker-compose.yml` dev stack). Fewer environments to keep in sync.

## Alternatives considered (delta from ADR-0005)

ADR-0005 considered Render, AWS, Fly.io, Railway, DigitalOcean, all-Cloudflare, and Hetzner-without-Coolify. The conclusion against Hetzner was:

> "Hetzner / self-managed VPS. Cheapest option, but reintroduces all the ops work (Postgres backups, Redis HA, TLS rotation) that Render abstracts. Wrong tradeoff for a small team optimizing for time, not just dollars."

That conclusion was correct **for raw VPS + manual systemd**. **Coolify changes the calculus**: it abstracts most of those concerns behind a UI. The remaining ops work — Coolify upgrades, restore drills, OS patches — is materially smaller than rolling your own.

The Render Postgres pricing surprise also revisits the cost math. ADR-0005 priced "$30–50/mo more than Hetzner is worth it to avoid ops". With actual Render pricing, that gap is **$120+/mo**, which is past the threshold MVP economics tolerate.

- **Stay on Render with Postgres downsize.** Drops `basic-4gb → basic-1gb`, total ~$50–55/mo for Tarmoto. Still $600+/year more than Hetzner+Coolify, and `basic-1gb` is closer to MVP-floor sizing — first real growth would force re-upgrade. Rejected.
- **Two Hetzner VPSes, one per app.** 2× CX23 = €10.86/mo vs 1× CX33 at €8.46/mo. More expensive AND more ops surface (two boxes to patch, two Coolifies to upgrade). Rejected.
- **Hetzner without Coolify** (raw Docker Compose + systemd + manual TLS). Cheapest, but reintroduces the ops cost ADR-0005 worried about. Rejected.
- **Fly.io / Railway / DigitalOcean App Platform.** Same managed-PaaS shape as Render. Pricing slightly different but same order of magnitude as Render's new tiers. The earlier "team has no operational history there" objection from ADR-0005 still applies — and we've now got Coolify experience landing instead. Rejected.

## Migration plan

1. ✅ Provision Hetzner CX33 (Helsinki) + install Coolify at `coolify.studio81.cz`.
2. ✅ Generate Coolify API token, store in GitHub Secrets as `COOLIFY_API_TOKEN`.
3. **In Coolify dashboard:** connect GitHub source, create `tarmoto-prod` project, add Postgres + Redis + Application resources.
4. **In Coolify dashboard:** populate env vars (mirrors `infra/render/render.yaml`'s var set, with Coolify-internal hostnames for DB + Redis).
5. **In Coolify dashboard:** add `api.tarmoto.app` domain to the Application; Coolify provisions the Let's Encrypt cert.
6. **DNS:** Cloudflare A record `api.tarmoto.app` → `89.167.80.252`. Either DNS-only or Proxied is fine.
7. **First deploy:** click Deploy in Coolify; watch logs; verify `https://api.tarmoto.app/api/v1/healthz` returns 200.
8. **Restore drill:** snapshot the (still-empty) Postgres → R2; spin up a sibling Postgres in Coolify; restore the snapshot; confirm `psql` connectivity. Document any gotchas in the runbook.
9. **Rewrite `.github/workflows/backend-deploy.yml`** to use Coolify's API for poll + rollback. Same smoke contract (`scripts/smoke/smoke.sh`).
10. **Decommission Render** once first Coolify deploy serves real traffic for ≥24h: cancel Web Service, Postgres, Key Value. `infra/render/` stays in repo for one release cycle as a historical reference.
11. **Repeat steps 3–9 for Nexcue** when it leaves the free tier.
12. Flip ADR-0006 status to `Accepted`.

## Issue tracking

- [`#398`](https://github.com/Studio81Labs/tarmoto/issues/398) — reframe body so the operator checklist points at Coolify (Steps 1, 2, 5 of #398's list become obsolete; Steps 2 (R2), 4 (DNS), and the Stripe/OWM secrets sub-list carry over verbatim into Coolify's env-var page).
- New issue: "Decommission `infra/render/` once Coolify is serving real traffic for ≥24h" — single-deliverable cleanup PR.
