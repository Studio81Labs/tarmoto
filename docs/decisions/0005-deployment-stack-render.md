# 0005 — Deployment stack: Render for backend, Cloudflare for everything web-facing, Fastlane for mobile

**Status:** Proposed
**Date:** 2026-05-03
**Supersedes:** [ADR-0004](./0004-deployment-stack.md)

## Context

ADR-0004 was accepted on 2026-05-02 and committed Terraform, ECS, RDS, ElastiCache, ALB, NAT, S3, CloudFront, Secrets Manager, and ECR for the backend. None of it has been `terraform apply`'d. Within a day of writing it down, the cost shape became visible:

| Surface            | AWS as planned (per env, /mo)    | Render + Cloudflare (per env, /mo) |
| ------------------ | -------------------------------- | ---------------------------------- |
| Backend container  | ECS Fargate ~$15–20              | Web Service Standard ~$25          |
| Postgres + PostGIS | RDS db.t4g.medium ~$60+          | Managed Postgres Standard ~$19     |
| Redis              | ElastiCache cache.t4g.small ~$25 | Render Key Value Starter ~$10      |
| Load balancer      | ALB ~$20                         | included with Web Service          |
| Egress / NAT       | NAT GW ~$32                      | included                           |
| Object storage     | S3 + CloudFront, variable egress | Cloudflare R2, no egress fees      |
| Secrets            | Secrets Manager $0.40/secret     | env vars, free                     |
| **Floor**          | **~$160–180**                    | **~$55**                           |

Roughly 3× per env, and we want staging _and_ prod. For a pre-revenue MVP that's a real budget pull. The team also already runs a NestJS + Postgres workload on Render on a sibling project — operational know-how exists; AWS would be a fresh learning curve for whoever is on call.

ADR-0004's stated technical objections to non-AWS deploys were:

- **PostGIS query needs.** Resolved on Render: managed Postgres is vanilla Postgres 16, `CREATE EXTENSION postgis` runs in our existing TypeORM migration. We don't need RDS-specific PostGIS tooling.
- **BullMQ Redis affinity.** Resolved on Render: Key Value is Redis-protocol-compatible; BullMQ does not need ElastiCache features.
- **WebSocket lifetime.** This was scoped against Cloudflare Workers, not Render. Render Web Services hold long-lived TCP connections like any container runtime; restart-on-deploy behavior matches ECS.

So ADR-0004's rejection of "all-Cloudflare backend" still stands, but it doesn't generalize to Render.

## Decision

### Backend: Render

- **Web Service** running the existing NestJS Docker image (we'll add a `Dockerfile` to `apps/backend/`).
- **Render Postgres** with `postgis` extension created via the existing TypeORM migration. One instance per env.
- **Render Key Value** (Redis-compatible) for BullMQ + pub/sub. One instance per env.
- **Render Cron Jobs** for the scheduled work currently expected to run via the same task with `TARMOTO_QUEUE_WORKER_ENABLED`. We keep the env-flag pattern; cron just hits a worker entrypoint.
- Config via Render's Environment Groups (one per env). Secrets are env vars marked secret in the dashboard — no separate secret-store service.
- Deploys are git-push-based via [`render.yaml`](https://render.com/docs/blueprint-spec) Blueprint, committed under `infra/render/`. The Blueprint is the IaC; preview environments use Render's PR Preview feature where applicable.
- Rollback is "redeploy a previous commit" from the Render dashboard or CLI.

### Object storage: Cloudflare R2

- S3-compatible API; the backend's existing storage driver (`TARMOTO_STORAGE_DRIVER=s3`) keeps working with an endpoint override.
- Buckets: `uploads`, `exports`, `tiles` (mirrors today's intended layout).
- No egress fees — meaningful for tile cache and image delivery, where AWS's per-GB egress was a recurring concern.
- Lifecycle rules (auto-expire `exports/`) configured via R2's Object Lifecycle Policies.

### Companion: Cloudflare Workers (unchanged)

`@opennextjs/cloudflare` deploy at `apps/companion/wrangler.jsonc` stays as-is. Already in production.

### PoC sensor: Cloudflare Pages (unchanged)

### Mobile: Fastlane → App Store / Play Store (unchanged)

ADR-0004's Fastlane / TestFlight / Play Internal section carries over verbatim.

### Domain / DNS

Cloudflare DNS for all hostnames. Render services are reached via custom domain CNAME → Render's auto-provisioned cert + load balancer.

## Consequences

- **`infra/aws/` is removed.** Terraform modules, env roots, and `infra/aws/README.md` are deleted. Whatever AWS resources do exist (ECR repos created during dry runs, the state S3 bucket from `infra/aws/bootstrap`) are torn down out-of-band by the operator and noted in [`docs/process/runbook.md`](../process/runbook.md).
- **`.github/workflows/backend-deploy.yml` is rewritten** to deploy via Render's Deploy Hooks (or git-push trigger) instead of `aws-actions/amazon-ecs-deploy-task-definition`. Smoke tests still run after deploy; rollback is "redeploy previous commit".
- **Issues [#347](https://github.com/Studio81Labs/tarmoto/issues/347) and [#381](https://github.com/Studio81Labs/tarmoto/issues/381)** become won't-do — they were AWS Secrets Manager mechanics. FCM + APN credentials move to Render env vars (still secret-flagged, still env-scoped).
- **One vendor instead of two for app-layer hosting**, plus Cloudflare for everything web-facing. We accept Render-specific concepts (Blueprints, Environment Groups, Deploy Hooks) as the new operability surface — but the team already has them.
- **Less knobs.** No VPC, subnets, security groups, IAM, NAT topology, parameter groups, target group health-check tuning. The tradeoff is less control if we ever need it. For an MVP, this is a feature.
- **Object storage egress is free**, which removes a class of cost surprise that AWS S3 + CloudFront would have brought.
- **Single-region by default.** Render lets us pick a region per service; multi-region is a follow-up if/when latency demands it. AWS's multi-AZ would not have been multi-region either, so this is no worse.
- **No managed observability stack.** Render gives us logs + basic metrics; we keep CloudWatch-style detail off the table for now and can add Better Stack / Grafana Cloud later as a separate ADR.
- **Docs and references touching AWS need a sweep:** [`docs/reference/architecture.md`](../reference/architecture.md), [`docs/process/runbook.md`](../process/runbook.md), [`docs/specs/tarmoto-product-spec.md`](../specs/tarmoto-product-spec.md), and [`AGENTS.md`](../../AGENTS.md). Tracked as a follow-up issue at acceptance time.

## Alternatives considered

- **Stick with AWS as ADR-0004 specified.** Rejected on cost (3× per env) and operational ramp; the technical justification ("AWS-class control plane") doesn't pay for itself at MVP scale.
- **Fly.io.** Comparable price and developer experience to Render; PostGIS works. Rejected because the team has no Fly.io operational history but does have a live Render workload — picking the unfamiliar option to save a few dollars isn't worth it.
- **Railway.** Similar pitch to Render. Rejected on the same "we already run on Render" basis, plus Railway's pricing model has shifted twice in the last year and Render's has been stable.
- **DigitalOcean App Platform.** Workable, but adds a third vendor (DO + Cloudflare + the existing app-store stack). Render+Cloudflare keeps it at two.
- **All-Cloudflare backend (Workers + Hyperdrive + R2).** Same rejection as ADR-0004 — Workers' WebSocket lifetime and BullMQ Redis affinity push the backend out of the Workers' sweet spot. Worth revisiting if Cloudflare Containers matures.
- **Hetzner / self-managed VPS.** Cheapest option, but reintroduces all the ops work (Postgres backups, Redis HA, TLS rotation) that Render abstracts. Wrong tradeoff for a small team optimizing for time, not just dollars.
