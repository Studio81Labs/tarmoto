# Tarmoto — Agent Instructions

## Project

Tarmoto is a motorcycle companion app with crowdsourced road surface quality intelligence, real-time hazard alerts, and multi-day trip planning. Monorepo with bare React Native mobile app, NestJS backend, and Next.js web companion.

## Repository Layout

- `apps/mobile/` — Bare React Native (TypeScript) — sensors, TF Lite, CarPlay
- `apps/backend/` — NestJS API (TypeScript, serves both mobile and web)
- `apps/companion/` — Web companion (Next.js + TailwindCSS) — trip planner, ride history, account management
- `apps/poc-sensor/` — Road quality sensor PoC (Vite + React, deployed to Cloudflare Pages)
- `packages/shared/` — Shared types, constants, DTOs (`@tarmoto/shared`)
- `packages/openapi/` — OpenAPI spec generation from backend
- `docs/specs/` — Product spec (canonical source of truth)
- `docs/decisions/` — ADRs
- `docs/reference/` — Architecture overview and reference material
- `docs/process/` — Operational docs (runbook, testing strategy, TypeORM migrations, DoD, issue workflow)
- `docs/design/` — Wireframes, ERD (Vite app, run with `pnpm dev:docs`)
- `docs/database/` — PostgreSQL + PostGIS schema

## Tech Stack

- **Runtime**: Node 24+, pnpm workspaces
- **Mobile**: Bare React Native 0.85, TypeScript, Zustand, MapLibre GL
- **Companion (web)**: Next.js + TailwindCSS, Zustand, MapLibre GL
- **Backend**: NestJS 11, TypeORM, TypeScript strict
- **Database**: PostgreSQL 16 + PostGIS 3.4 (Docker)
- **Maps**: MapLibre GL + custom vector tiles
- **ML**: TensorFlow Lite (on-device)

## Commands

```bash
pnpm install              # Install all workspace deps
pnpm dev:backend          # NestJS dev server (watch mode)
pnpm dev:mobile           # Metro bundler
pnpm ios                  # Run on iOS simulator
pnpm android              # Run on Android emulator
pnpm dev:companion        # Companion (web) dev server
pnpm dev:docs             # Design docs viewer (wireframes + ERD) on :4200
pnpm dev:poc              # PoC sensor app dev server
pnpm db:up                # Start PostgreSQL + Redis via Docker
pnpm db:down              # Stop Docker services
pnpm db:migrate           # Build backend + run TypeORM migrations
pnpm build:backend        # Build backend
pnpm build:companion      # Build companion (web)
pnpm build:poc            # Build PoC sensor
pnpm build:shared         # Build shared package
pnpm test                 # Run all tests
pnpm lint                 # Lint all packages
```

## Conventions

- Package names use `@tarmoto/` scope
- Backend is called "backend" (not "api") — it serves mobile app and web
- TypeScript strict mode everywhere
- Shared types/constants go in `packages/shared`
- Domain enums (hazard types, surface types, ride types) are defined in `@tarmoto/shared`
- Env vars use `TARMOTO_` prefix (e.g. `TARMOTO_DATABASE_HOST`)
- Database: TypeORM with native PostGIS geometry columns (not Prisma — Prisma lacks PostGIS support)
- Entities in `apps/backend/src/entities/`, feature modules in `apps/backend/src/modules/`
- Docker services in `infra/docker/docker-compose.yml`
- Units: backend stores and serves **metric only** (°C, km/h, meters, km). Clients convert for display using `@tarmoto/shared` unit helpers based on user preference

## Review Guidance

- During code review, do not limit findings to only obvious critical bugs. Surface medium-risk regressions when the user impact or cleanup cost is real.
- Treat these as review-worthy findings, not optional nits:
  - Missing or weak tests for behavior changes, edge cases, null/error paths, or regression-prone logic
  - Contract drift between backend DTOs, OpenAPI output, shared types, mobile consumers, and companion consumers
  - Missing migrations, docs, or follow-up contract updates when schema or API behavior changes
  - Metric/unit mistakes, especially backend values that leak non-metric assumptions into persisted or served data
  - Performance risks such as N+1 queries, unbounded queries/lists, repeated geospatial work, or avoidable map/render hot paths
  - Error-handling, observability, auth, privacy, and secret-handling gaps that would make production incidents or data leaks more likely
- Prefer high-signal findings with a concrete failure mode, regression path, or operational risk. Skip pure formatting/style comments unless they hide a real defect.
- If the review surface supports lower-severity findings, use them. If it does not, still report medium-risk issues when they are concrete and actionable.
