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
pnpm dev:backend                 # Backend watch mode
pnpm dev:mobile                  # Metro bundler (then `pnpm ios` / `pnpm android`)
pnpm dev:companion               # Next.js companion (web)
pnpm dev:docs                    # Design docs viewer on :4200
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
pnpm build:shared        # Build @tarmoto/shared (backend depends on it)
pnpm build:backend       # Compile backend (TypeORM reads compiled data-source)
pnpm db:migrate          # Run migrations against Postgres
pnpm dev:backend         # Start backend in watch mode
```

### After editing `Info.plist` or `AndroidManifest.xml`

Native manifest changes don't propagate through a Metro reload — the
React Native bundle is unchanged, but the underlying iOS/Android binary
still embeds the old manifest. After editing either file:

```bash
# iOS
cd apps/mobile/ios && pod install && cd -
pnpm ios     # forces a fresh xcodebuild

# Android
cd apps/mobile/android && ./gradlew clean && cd -
pnpm android
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
│   └── poc-sensor/          Road quality sensor PoC (Cloudflare Pages)
├── packages/
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
│   ├── docker/              docker-compose (Postgres + Redis)
│   └── render/              Render Blueprint (Postgres + Key Value + backend Web Service)
└── .github/                 CI workflows, issue templates, deploy pipelines
```

## Commands

| Command                     | Description                                            |
| --------------------------- | ------------------------------------------------------ |
| `pnpm bootstrap`            | Full dev environment setup                             |
| `pnpm install`              | Install workspace dependencies                         |
| `pnpm dev:backend`          | Start backend in watch mode                            |
| `pnpm dev:mobile`           | Start Metro bundler                                    |
| `pnpm ios` / `pnpm android` | Run mobile on simulator / emulator                     |
| `pnpm dev:companion`        | Start companion (Next.js) dev server                   |
| `pnpm dev:poc`              | Start PoC sensor dev server                            |
| `pnpm dev:docs`             | Design docs viewer (wireframes + ERD) on `:4200`       |
| `pnpm build:backend`        | Build backend                                          |
| `pnpm build:companion`      | Build companion                                        |
| `pnpm build:shared`         | Build shared package                                   |
| `pnpm build:poc`            | Build PoC sensor                                       |
| `pnpm db:up`                | Start PostgreSQL + Redis via Docker                    |
| `pnpm db:down`              | Stop Docker services                                   |
| `pnpm db:migrate`           | Build backend + run TypeORM migrations                 |
| `pnpm generate:api`         | Generate OpenAPI spec + TypeScript client from backend |
| `pnpm lint`                 | Lint all packages                                      |
| `pnpm test`                 | Run backend tests                                      |
| `pnpm clean`                | Remove `dist/` + `node_modules/`                       |

## Development Workflow

```
Backend (NestJS + TypeORM + PostGIS)
    ↓  pnpm generate:api
OpenAPI spec + TypeScript client  (packages/openapi/ — gitignored)
    ↓
Mobile (React Native) & Companion (Next.js) consume @tarmoto/openapi
```

1. Make backend changes in `apps/backend/` with `@nestjs/swagger` decorators.
2. Run `pnpm generate:api` to regenerate the OpenAPI spec and TypeScript client.
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

- **Backend** — Render Web Service running the [`apps/backend/Dockerfile`](./apps/backend/Dockerfile); managed Render Postgres (PostGIS via migration) and Render Key Value (Redis-compatible) for queues / pub-sub; Cloudflare R2 for object storage. Blueprint under [`infra/render/`](./infra/render/), deploy via [`.github/workflows/backend-deploy.yml`](./.github/workflows/backend-deploy.yml). Staging auto-deploys on push to `main`; prod is gated behind a manual approval and tag-driven (`backend-vX.Y.Z`).
- **Companion** — Cloudflare Workers (OpenNext) with PR previews; deploy via [`.github/workflows/companion-deploy.yml`](./.github/workflows/companion-deploy.yml).
- **Mobile** — Fastlane lanes for iOS TestFlight and Android Play Internal track; manual `workflow_dispatch` or `mobile-vX.Y.Z` tag, see [`.github/workflows/mobile-release.yml`](./.github/workflows/mobile-release.yml).
- **PoC sensor** — Cloudflare Pages on push to `main` via [`poc-deploy.yml`](./.github/workflows/poc-deploy.yml).

Stack rationale and tradeoffs are in [ADR 0005](./docs/decisions/0005-deployment-stack-render.md). Deploy / rollback runbook is in [docs/process/runbook.md](./docs/process/runbook.md#production-deploys).

## Bootstrap Details

`pnpm bootstrap` runs `scripts/bootstrap.sh`, which:

1. Checks prerequisites (node, pnpm, docker)
2. Runs `pnpm install`
3. Copies `.env.example` to `.env` for backend, mobile, and companion (if not present)
4. Starts Postgres + Redis via Docker Compose and waits for Postgres to be healthy
5. Builds `@tarmoto/shared` and the backend (TypeORM needs the compiled data-source)
6. Runs TypeORM migrations
7. Prints the next local commands

## Related Repos

- [GetTarmoto/web](https://github.com/GetTarmoto/web) — Landing page, PoC sensor, brand assets

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branching, commit conventions, PR flow, and what not to commit. For a system overview see [docs/reference/architecture.md](./docs/reference/architecture.md).

## License

Proprietary — All rights reserved.
