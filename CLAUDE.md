# CLAUDE.md — Tarmoto

## Project

Tarmoto is a motorcycle companion app with crowdsourced road surface quality intelligence, real-time hazard alerts, and multi-day trip planning. Monorepo with React Native (Expo) mobile app and NestJS backend.

## Repository Layout

- `apps/mobile/` — React Native + Expo (TypeScript)
- `apps/backend/` — NestJS API (TypeScript, serves both mobile and web)
- `packages/shared/` — Shared types, constants, DTOs (`@tarmoto/shared`)
- `docs/prd/` — Product requirements
- `docs/design/` — Wireframes, ERD (Vite app, run with `pnpm dev:docs`)
- `docs/database/` — PostgreSQL + PostGIS schema
- `docs/scripts/` — Python utility scripts (ride analysis, OSM curviness, GitHub issue creation)

## Tech Stack

- **Runtime**: Node 24+, pnpm workspaces
- **Mobile**: React Native + Expo, TypeScript
- **Backend**: NestJS, TypeScript strict
- **Database**: PostgreSQL 16+ with PostGIS
- **Maps**: MapLibre GL + custom vector tiles
- **ML**: TensorFlow Lite (on-device)

## Commands

```bash
pnpm install              # Install all workspace deps
pnpm dev:backend          # NestJS dev server (watch mode)
pnpm dev:mobile           # Expo dev server
pnpm dev:docs             # Design docs viewer (wireframes + ERD) on :4200
pnpm build:backend        # Build backend
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
