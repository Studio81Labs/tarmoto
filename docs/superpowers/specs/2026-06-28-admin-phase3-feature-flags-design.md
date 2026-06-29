# Tarmoto Admin — Phase 3: Feature Flags — Design

- **Date:** 2026-06-28
- **Status:** Approved (design); pending implementation plan
- **Builds on:** Phase 1 admin console (#718), `@tarmoto/ui` adoption (#720), `create-admin` CLI (#721), Phase 2 User & Admin Management (#722) — all merged to `main`.
- **Scope:** A **Feature Flags** admin surface — operators create / toggle / delete boolean feature flags — plus a public client read endpoint so the flags are actually consumable. This is the first schema-bearing admin phase (it adds a migration).

## 1. Background & motivation

Phases 1–2 delivered the admin foundation (separate `admin_users` identity, cookie JWT sessions, GitHub SSO, `InternalGuard` + role rank, audit log/interceptor, `setAdminAuditTarget`), the `@tarmoto/ui`-styled SPA shell with role-gated routes (`roleRank.ts` `canAccess`), and the User & Admin management surfaces.

There is **no feature-flag / remote-config infrastructure today** — this is greenfield. The admin Overview already declares a `featureFlags` metric, hardcoded to `0` (`admin-metrics.service.ts`), and the SPA has a `feature-flags` "Coming soon" stub route. This phase fills both in and gives the product a way to gate features without a deploy.

## 2. Goals & non-goals

### Goals

- A `feature_flags` store (new table + TypeORM migration).
- Admin CRUD: list, create, toggle/edit, delete — gated to `admin`+, fully audited.
- A **public** client read endpoint returning a flat `{ key: boolean }` map so mobile/companion can read flags on startup.
- Wire the Overview `featureFlags` tile to the real flag count.
- A shared `FeatureFlagMap` type + `isFeatureEnabled` helper for client consumers.

### Non-goals (this phase)

- **Typed/non-boolean values** (string/number) — booleans only this phase.
- **A fixed flag-key enum in `@tarmoto/shared`** — keys are free-form, created at runtime in the UI.
- **Percentage rollout / per-segment targeting / per-user evaluation** — each flag is a single global value. (A likely future phase.)
- **Wiring a specific mobile/companion feature behind a flag** — the consumption path is delivered, but gating an actual feature is a per-feature follow-up.
- **Migrating existing env toggles** (`TARMOTO_ADMIN_PASSWORD_LOGIN_ENABLED`, `TARMOTO_QUEUE_WORKER_ENABLED`, etc.) into the flag store — out of scope; noted as future candidates.

## 3. Architecture

```
apps/backend/src/entities/feature-flag.entity.ts            (new) feature_flags table
apps/backend/src/migrations/<ts>-CreateFeatureFlags.ts      (new) create table + unique index on key
apps/backend/src/modules/admin-flags/                       (new — admin CRUD)
  admin-flags.controller.ts        GET /admin/flags, POST /admin/flags,
                                   PATCH /admin/flags/:id, DELETE /admin/flags/:id
  admin-flags.service.ts           list / create / update / delete
  dto/admin-flags.dto.ts
apps/backend/src/modules/config/                            (new — public client read)
  config.controller.ts             GET /config/flags  (public, rate-limited)
  config.service.ts                returns { [key]: boolean }
  config.module.ts
apps/backend/src/modules/admin/admin.module.ts             register admin-flags + FeatureFlag entity
apps/backend/src/modules/admin/admin-metrics.service.ts    wire featureFlags -> flagRepo.count()

packages/shared/src/feature-flags.ts                       FeatureFlagMap + isFeatureEnabled
packages/shared/src/index.ts                               re-export

apps/admin/src/screens/FeatureFlagsScreen.tsx              list + create + toggle + delete
apps/admin/src/data/useAdminFlags.ts                       $api hooks
apps/admin/src/app/routes.ts                               set minRole: 'admin' on feature-flags
apps/admin/src/app/App.tsx                                 render FeatureFlagsScreen

packages/openapi-client/src/generated/schema.d.ts          regenerated for the new paths
```

All `/admin/*` routes are already covered by the global `InternalGuard` (auth + role rank) and `AdminAuditInterceptor` (mutation auditing). The new admin endpoints add `@AdminRoles('admin')`; mutations call `setAdminAuditTarget`. The public client endpoint lives in its own module **outside** the `/admin` prefix and is not subject to the admin guard.

## 4. Data model

`feature_flags` table:

| Column        | Type         | Notes                                                             |
| ------------- | ------------ | ----------------------------------------------------------------- |
| `id`          | uuid         | `@PrimaryGeneratedColumn('uuid')`                                 |
| `key`         | varchar(128) | **unique**, immutable after create, validated `^[a-z][a-z0-9_]*$` |
| `enabled`     | boolean      | default `false`                                                   |
| `description` | varchar(500) | nullable                                                          |
| `created_at`  | timestamptz  | `@CreateDateColumn`                                               |
| `updated_at`  | timestamptz  | `@UpdateDateColumn`                                               |

A TypeORM migration creates the table and a unique index on `key`. No `deleted_at` — flags are hard-deleted (a deleted flag simply disappears from the map and consumers fall back to their default).

## 5. Surfaces & endpoints

### 5.1 Admin → Feature Flags (operators)

All require **`admin`+**, are auto-audited, and set an audit target on mutations.

- `GET /admin/flags` — list all flags: `id, key, enabled, description, created_at, updated_at`. Ordered by `key`.
- `POST /admin/flags` — `{ key, enabled?, description? }`. Validates key format (lowercase snake_case, ≤128) → `400`; duplicate key → `409` (mirrors admins-create). `enabled` defaults to `false`.
- `PATCH /admin/flags/:id` — `{ enabled?, description? }` only. **`key` is immutable** (renaming would silently break consumers). `404` if not found.
- `DELETE /admin/flags/:id` — hard delete. `404` if not found. `setAdminAuditTarget(req, { target_type: 'feature_flag', target_id: id })`.

### 5.2 Client read

- `GET /api/v1/config/flags` — **public** (no auth), rate-limited, returns a flat `Record<string, boolean>` of all flags (`key → enabled`). Response carries `Cache-Control: public, max-age=60`. Only `key` + `enabled` are exposed — no descriptions or internal metadata. Rationale: feature gates are not secrets, and clients fetch config on startup (possibly before login).

## 6. Authorization model

- **Admin flags surface:** `admin`+ for both read and write (operator controls; `read_only`/`support` do not see the surface). The SPA route carries `minRole: 'admin'`, so the nav item is hidden and the screen falls back to the access-denied state for lower roles.
- **Client `/config/flags`:** public/unauthenticated. It exposes only flag keys + booleans.
- **Overview tile:** the `featureFlags` count is part of `GET /admin/metrics` (already visible per its existing gating); it shows the total number of flags.

## 7. Data flow, errors, contracts, testing

- **Data flow:** Admin SPA → typed `@tarmoto/openapi-client` over `/api/v1/admin/flags` → guarded controller → service → TypeORM. Clients → `GET /api/v1/config/flags` → `config.service` → TypeORM → flat map. React Query for the SPA reads + mutations.
- **Errors:** no silent fallbacks — invalid key → `400`, duplicate key → `409`, not-found → `404`, all with explicit messages the SPA surfaces via `Alert` (reusing the Phase-2 `statusCode`/`message` error-reading pattern).
- **Contracts:** new DTOs → OpenAPI (`@tarmoto/openapi`) → regenerated `@tarmoto/openapi-client`; the public response shape is also expressed as `FeatureFlagMap` in `@tarmoto/shared` for non-SPA consumers. SPA uses the prefixed `/api/v1/...` paths and types rows from the generated `components`.
- **Migration:** a TypeORM migration is required and must be runnable up and down (`pnpm db:migrate`). Document it in the change.
- **Tests:**
  - Backend: service CRUD (list/create/update/delete), key-format validation, duplicate-key 409, key-immutability on patch, not-found 404; controller gating (`@AdminRoles('admin')` — denied for lower roles) + audit-target wiring; the public config endpoint (returns the map, requires no auth, sets cache header); Overview metric reflects the count; migration up/down.
  - SPA: the screen renders the flag list from mocked hooks; create/toggle/delete invoke the right endpoints and refetch; the route is gated (`admin`+) — hidden / access-denied for lower roles; server errors surfaced.

## 8. Implementation slices (one spec → ~4 plan sections)

1. **Backend — store**: `FeatureFlag` entity + migration + `@tarmoto/shared` `FeatureFlagMap`/`isFeatureEnabled` + tests.
2. **Backend — admin CRUD**: service/DTOs/controller (validation + 409 + immutable key + audit target) + register in `AdminModule` + wire the Overview `featureFlags` count + regenerate OpenAPI + tests.
3. **Backend — public read**: `config` module with `GET /config/flags` (public, rate-limited, cache header) + tests.
4. **SPA — Feature Flags screen**: list + create form + per-row toggle + delete-with-confirm + hooks + route `minRole: 'admin'` + render in `App` + tests.

## 9. Key assumptions (flagged)

- Booleans only; free-form runtime keys; global on/off — richer value types, a typed key registry, and rollout targeting are explicitly deferred.
- The client read endpoint is public/unauthenticated and exposes only key+enabled.
- `key` is immutable after creation; changing a flag's identity means deleting and recreating it.
- Existing env toggles are not migrated into the store this phase.
- No production-deploy work here (the admin prod deployment remains a tracked follow-up from Phase 1).
