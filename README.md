# Tarmoto

> **Know the road before you ride it.**

The motorcycle app that tells you how good the actual road surface is — not just how curvy it looks on a map. Crowdsourced road quality intelligence, real-time hazard alerts, and a multi-day trip planner that replaces hours of Street View scouting.

## Quick Start

```bash
git clone <repo-url> && cd tarmoto
pnpm bootstrap
```

That single command installs dependencies, starts Postgres + Redis, builds shared + backend, copies `.env.example` files, and runs migrations. See [Bootstrap Details](#bootstrap-details) below.

After bootstrap:

```bash
pnpm backend:dev                 # Backend watch mode
pnpm mobile:dev                  # Metro bundler (then `pnpm mobile:ios` / `pnpm mobile:android`)
pnpm companion:dev               # Next.js companion (web)
pnpm docs:dev                    # Design docs viewer on :4200
```

## Prerequisites

- Node.js >= 24 (see `.nvmrc`)
- pnpm >= 10
- Docker & Docker Compose
- Xcode (iOS) or Android Studio (Android) for mobile development

## Manual Setup

If `pnpm bootstrap` doesn't fit your environment:

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env
cp apps/mobile/.env.example apps/mobile/.env
cp apps/companion/.env.example apps/companion/.env
pnpm db:up               # Start PostgreSQL + Redis in Docker
pnpm shared:build        # Build @tarmoto/shared (backend depends on it)
pnpm backend:build       # Compile backend (TypeORM reads compiled data-source)
pnpm db:migrate          # Run migrations against Postgres
pnpm backend:dev         # Start backend in watch mode
```

### After editing `Info.plist` or `AndroidManifest.xml`

Native manifest changes don't propagate through a Metro reload — the
React Native bundle is unchanged, but the underlying iOS/Android binary
still embeds the old manifest. After editing either file:

```bash
# iOS
cd apps/mobile/ios && pod install && cd -
pnpm mobile:ios     # forces a fresh xcodebuild

# Android
cd apps/mobile/android && ./gradlew clean && cd -
pnpm mobile:android
```

If location, sensors, notifications, or photo capture stop working
after a permission edit, 9 times out of 10 the binary on the device is
stale. Uninstall the app and reinstall to be sure — Android in
particular caches the granted permission set per install.

## Project Structure

```
tarmoto/
├── apps/
│   ├── mobile/              Bare React Native (iOS & Android)
│   ├── backend/             NestJS API (serves mobile + web)
│   ├── companion/           Web companion (Next.js + TailwindCSS)
│   ├── marketing/           Marketing site (Astro) + waitlist worker
│   └── poc-sensor/          Road quality sensor PoC (Cloudflare Pages)
├── packages/
│   ├── brand/               Brand identity system (logos, colors, fonts)
│   ├── shared/              Shared types, constants, DTOs
│   └── openapi/             OpenAPI spec generation from backend
├── docs/
│   ├── specs/               Product spec (canonical)
│   ├── decisions/           ADRs
│   ├── reference/           Architecture overview + reference material
│   ├── process/             Runbook, testing, migrations, DoD, issue workflow
│   ├── design/              Wireframes, ERD
│   └── database/            PostgreSQL + PostGIS schema
├── infra/
│   └── docker/              docker-compose (Postgres + Redis)
└── .github/                 CI workflows, issue templates, deploy pipelines
```

## Commands

| Command                                   | Description                                            |
| ----------------------------------------- | ------------------------------------------------------ |
| `pnpm bootstrap`                          | Full dev environment setup                             |
| `pnpm install`                            | Install workspace dependencies                         |
| `pnpm backend:dev`                        | Start backend in watch mode                            |
| `pnpm backend:build`                      | Build backend                                          |
| `pnpm backend:start`                      | Start backend in production mode                       |
| `pnpm backend:lint`                       | Lint backend                                           |
| `pnpm backend:test`                       | Run backend unit tests                                 |
| `pnpm backend:test:watch`                 | Run backend tests in watch mode                        |
| `pnpm backend:test:cov`                   | Run backend tests with coverage                        |
| `pnpm backend:test:e2e`                   | Run backend E2E tests (requires `pnpm db:up`)          |
| `pnpm backend:db:migrate`                 | Build backend + run TypeORM migrations                 |
| `pnpm companion:dev`                      | Start companion (Next.js) dev server                   |
| `pnpm companion:build`                    | Build companion                                        |
| `pnpm companion:start`                    | Start companion in production mode                     |
| `pnpm companion:lint`                     | Lint companion                                         |
| `pnpm companion:test`                     | Run companion tests (Vitest)                           |
| `pnpm mobile:dev`                         | Start Metro bundler                                    |
| `pnpm mobile:ios` / `pnpm mobile:android` | Run mobile on simulator / emulator                     |
| `pnpm poc:dev`                            | Start PoC sensor dev server                            |
| `pnpm poc:build`                          | Build PoC sensor                                       |
| `pnpm shared:build`                       | Build shared package                                   |
| `pnpm openapi:gen`                        | Generate OpenAPI spec + TypeScript client from backend |
| `pnpm docs:dev`                           | Design docs viewer (wireframes + ERD) on `:4200`       |
| `pnpm db:up`                              | Start PostgreSQL + Redis via Docker                    |
| `pnpm db:down`                            | Stop Docker services                                   |
| `pnpm db:migrate`                         | Alias for `backend:db:migrate`                         |
| `pnpm lint`                               | Lint all packages                                      |
| `pnpm test`                               | Run all tests                                          |
| `pnpm clean`                              | Remove `dist/` + `node_modules/`                       |

## Development Workflow

```
Backend (NestJS + TypeORM + PostGIS)
    ↓  pnpm openapi:gen
OpenAPI spec + TypeScript client  (packages/openapi/ — gitignored)
    ↓
Mobile (React Native) & Companion (Next.js) consume @tarmoto/openapi
```

1. Make backend changes in `apps/backend/` with `@nestjs/swagger` decorators.
2. Run `pnpm openapi:gen` to regenerate the OpenAPI spec and TypeScript client.
3. Mobile and companion import the typed client from `@tarmoto/openapi`.

For database schema changes, see [docs/process/typeorm-migrations.md](./docs/process/typeorm-migrations.md).

## Tech Stack

| Layer           | Technology                                      |
| --------------- | ----------------------------------------------- |
| Mobile          | Bare React Native 0.85, Zustand, MapLibre GL    |
| Companion (web) | Next.js, TailwindCSS, Zustand, MapLibre GL      |
| Backend         | NestJS 11, TypeORM, TypeScript strict           |
| Database        | PostgreSQL 16 + PostGIS 3.4                     |
| Real-time       | WebSockets + Redis Pub/Sub                      |
| On-device ML    | TensorFlow Lite (road-surface classifier)       |
| Contracts       | OpenAPI 3.0 (generated from backend)            |
| Infra           | pnpm workspaces, Docker Compose, GitHub Actions |

## Docs

- [Architecture overview](./docs/reference/architecture.md) — system shape, modules, data flows
- [Product spec](./docs/specs/tarmoto-product-spec.md) — canonical PRD
- [Runbook](./docs/process/runbook.md) — operational response
- [Testing strategy](./docs/process/testing-strategy.md)
- [TypeORM migrations](./docs/process/typeorm-migrations.md)
- [Definition of Done](./docs/process/definition-of-done.md)
- [Issue workflow](./docs/process/issue-workflow.md)
- [ML model spec](./docs/ML_MODEL_SPEC.md)
- [Database schema](./docs/database/schema.sql)
- [Wireframes + ERD](./docs/design/)

## Deployment

- **Backend** — Hetzner CX33 + Coolify running the [`apps/backend/Dockerfile`](./apps/backend/Dockerfile); Coolify-managed Postgres (PostGIS via migration) and Redis for queues / pub-sub; Cloudflare R2 for object storage. Push to `main` triggers Coolify's auto-deploy; the deploy workflow in [`.github/workflows/backend-deploy.yml`](./.github/workflows/backend-deploy.yml) waits for healthcheck, smoke-tests, and auto-rolls back on failure. The `production` GitHub environment can gate the smoke + rollback step on reviewer approval. No separate staging environment — pre-prod validation runs against the local Docker Compose stack ([ADR-0006](./docs/decisions/0006-deployment-stack-hetzner-coolify.md)).
- **Companion** — Cloudflare Workers (OpenNext) with PR previews; deploy via [`.github/workflows/companion-deploy.yml`](./.github/workflows/companion-deploy.yml).
- **Mobile** — Fastlane lanes for iOS TestFlight and Android Play Internal track; manual `workflow_dispatch` or `mobile-vX.Y.Z` tag, see [`.github/workflows/mobile-release.yml`](./.github/workflows/mobile-release.yml).
- **Marketing site** — Astro static site + waitlist Cloudflare Worker deployed to Cloudflare Pages + Workers via [`.github/workflows/marketing-deploy.yml`](./.github/workflows/marketing-deploy.yml).
- **PoC sensor** — Cloudflare Pages on push to `main` via [`poc-deploy.yml`](./.github/workflows/poc-deploy.yml).

Stack rationale and tradeoffs are in [ADR 0006](./docs/decisions/0006-deployment-stack-hetzner-coolify.md). Deploy / rollback runbook is in [docs/process/runbook.md](./docs/process/runbook.md#production-deploys).

## Bootstrap Details

`pnpm bootstrap` runs `scripts/bootstrap.sh`, which:

1. Checks prerequisites (node, pnpm, docker)
2. Runs `pnpm install`
3. Copies `.env.example` to `.env` for backend, mobile, and companion (if not present)
4. Starts Postgres + Redis via Docker Compose and waits for Postgres to be healthy
5. Builds `@tarmoto/shared` and the backend (TypeORM needs the compiled data-source)
6. Runs TypeORM migrations
7. Prints the next local commands

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branching, commit conventions, PR flow, and what not to commit. For a system overview see [docs/reference/architecture.md](./docs/reference/architecture.md).

## License

Proprietary — All rights reserved.
