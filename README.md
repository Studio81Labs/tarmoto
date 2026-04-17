# Tarmoto

> **Know the road before you ride it.**

The motorcycle app that tells you how good the actual road surface is — not just how curvy it looks on a map. Crowdsourced road quality intelligence, real-time hazard alerts, and a multi-day trip planner that replaces hours of Street View scouting.

## Status

**Phase: Concept validation**

- [x] Product Requirements Document
- [x] Wireframes (8 core screens)
- [x] System architecture
- [x] Database schema
- [x] PoC sensor app (accelerometer + GPS)
- [x] Landing page + waitlist
- [x] Brand identity
- [x] Repository structure + monorepo setup
- [ ] Accelerometer data validation (real rides)
- [x] ML model specification
- [x] API design (OpenAPI) — generated from NestJS swagger decorators via `pnpm generate:api`
- [ ] MVP development

## Repository Structure

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
└── .github/                 CI workflows, issue templates
```

## Tech Stack

- **Mobile**: React Native (bare)
- **Maps**: MapLibre GL + custom vector tiles
- **Backend**: NestJS
- **Database**: PostgreSQL + PostGIS
- **ML**: TensorFlow Lite (on-device) + Python (server)
- **Real-time**: WebSockets + Redis Pub/Sub
- **Cloud**: AWS (ECS, RDS, S3, CloudFront)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Client: React Native (iOS + Android + CarPlay/AA)  │
│  On-device: TensorFlow Lite (road classification)   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  API Gateway: REST + WebSocket · JWT · Rate limiting │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Services: Route Engine │ Trip Planner │ Safety │    │
│            Community │ Commute                       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Processing: Road Quality ML │ Tile Server │ Events  │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Storage: PostgreSQL/PostGIS │ Redis │ S3 │ Timescale│
└─────────────────────────────────────────────────────┘
```

## Key Differentiators

1. **Crowdsourced road surface quality** — accelerometer-based, every rider is a sensor
2. **Smart multi-day trip planner** — Fun Zone discovery, no more Street View scouting
3. **Real-time hazard alerts** — Waze-style, motorcycle-specific
4. **Commuter mode** — daily rider features, not just weekend touring
5. **Road preview cards** — surface quality, curves, hazards, reviews per segment

## Development

```bash
# Prerequisites: Node 24+, pnpm 10+

# Install all dependencies
pnpm install

# Run backend in dev mode
pnpm dev:backend

# Run mobile app (Metro bundler)
pnpm dev:mobile

# Run on iOS / Android
pnpm ios
pnpm android

# View wireframes + ERD locally (opens on :4200)
pnpm dev:docs

# Run all tests
pnpm test
```

## Docs

| Document | Description |
|----------|-------------|
| [Product spec](docs/specs/tarmoto-product-spec.md) | Product Requirements — vision, epics, 30 user stories, roadmap |
| [Schema](docs/database/schema.sql) | PostgreSQL + PostGIS database schema (15 tables) |
| [Wireframes](docs/design/wireframes.jsx) | Interactive wireframes — 8 core screens |
| [ERD](docs/design/database_erd.html) | Entity relationship diagram |
| [ML Spec](docs/ML_MODEL_SPEC.md) | Road surface classification model — architecture, features, training pipeline |

The OpenAPI spec is generated from NestJS swagger decorators — run `pnpm generate:api` to produce `packages/openapi/openapi.yaml` (gitignored).

## Related Repos

- [GetTarmoto/web](https://github.com/GetTarmoto/web) — Landing page, PoC sensor, brand assets

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branching, commit conventions, PR flow, and what not to commit. For a system overview see [docs/reference/architecture.md](./docs/reference/architecture.md).

## License

Proprietary — All rights reserved.
