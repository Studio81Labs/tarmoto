# Tarmoto

> **Know the road before you ride it.**

The motorcycle app that tells you how good the actual road surface is — not just how curvy it looks on a map. Crowdsourced road quality intelligence, real-time hazard alerts, and a multi-day trip planner that replaces hours of Street View scouting.

## Quick Start

```bash
git clone <repo-url> && cd tarmoto
pnpm install
pnpm db:up               # Start PostgreSQL + Redis in Docker
pnpm build:shared        # Build @tarmoto/shared (backend depends on it)
pnpm build:backend       # Compile backend (TypeORM reads compiled data-source)
pnpm db:migrate          # Run migrations against Postgres
pnpm dev:backend         # Start backend in watch mode
```

Then, in other terminals:

```bash
pnpm dev:mobile                  # Metro bundler
pnpm ios                         # or `pnpm android`
pnpm dev:companion               # Next.js companion (web)
pnpm dev:docs                    # Design docs viewer on :4200
```

## Prerequisites

- Node.js >= 24 (see `.nvmrc`)
- pnpm >= 10
- Docker & Docker Compose
- Xcode (iOS) or Android Studio (Android) for mobile development

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
├── infra/docker/            docker-compose (Postgres + Redis)
└── .github/                 CI workflows, issue templates
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm install` | Install workspace dependencies |
| `pnpm dev:backend` | Start backend in watch mode |
| `pnpm dev:mobile` | Start Metro bundler |
| `pnpm ios` / `pnpm android` | Run mobile on simulator / emulator |
| `pnpm dev:companion` | Start companion (Next.js) dev server |
| `pnpm dev:poc` | Start PoC sensor dev server |
| `pnpm dev:docs` | Design docs viewer (wireframes + ERD) on `:4200` |
| `pnpm build:backend` | Build backend |
| `pnpm build:companion` | Build companion |
| `pnpm build:shared` | Build shared package |
| `pnpm build:poc` | Build PoC sensor |
| `pnpm db:up` | Start PostgreSQL + Redis via Docker |
| `pnpm db:down` | Stop Docker services |
| `pnpm db:migrate` | Build backend + run TypeORM migrations |
| `pnpm generate:api` | Generate OpenAPI spec + TypeScript client from backend |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Run backend tests |
| `pnpm clean` | Remove `dist/` + `node_modules/` |

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

| Layer | Technology |
|-------|------------|
| Mobile | Bare React Native 0.85, Zustand, MapLibre GL |
| Companion (web) | Next.js, TailwindCSS, Zustand, MapLibre GL |
| Backend | NestJS 11, TypeORM, TypeScript strict |
| Database | PostgreSQL 16 + PostGIS 3.4 |
| Real-time | WebSockets + Redis Pub/Sub |
| On-device ML | TensorFlow Lite (road-surface classifier) |
| Contracts | OpenAPI 3.0 (generated from backend) |
| Infra | pnpm workspaces, Docker Compose, GitHub Actions |

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

- **PoC sensor** deploys to Cloudflare Pages via `deploy-poc.yml` on push to `main` (path filter `apps/poc-sensor/**`).
- **Backend, mobile, companion** deploys are not yet wired. Target per the product spec is AWS (ECS, RDS, S3, CloudFront).

## Related Repos

- [GetTarmoto/web](https://github.com/GetTarmoto/web) — Landing page, PoC sensor, brand assets

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branching, commit conventions, PR flow, and what not to commit. For a system overview see [docs/reference/architecture.md](./docs/reference/architecture.md).

## License

Proprietary — All rights reserved.
