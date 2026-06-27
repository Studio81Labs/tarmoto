# Tarmoto Admin Console — v1 Design

- **Date:** 2026-06-26
- **Status:** Approved (design); pending implementation plan
- **Scope:** New internal staff admin console (`apps/admin`) plus supporting backend admin modules, identity/RBAC, and a net-new feature-flag system.

## 1. Background & motivation

Tarmoto is growing: Valhalla-based navigation is landing (PR #717), and the
backend increasingly stores operator-curated and crowdsourced geo content —
POIs, road closures, detours, mountain passes. We also need to manage users and
roll features out safely via feature flags. None of this has an operational UI
today, and there is **no role/permission concept** in the codebase: the `users`
table has no role/admin column and the `auth` module has no admin guard.

This design introduces a separate internal admin console and the identity,
authorization, and feature-flag foundations it needs. It deliberately mirrors
the proven admin pattern from the sibling Studio81Labs projects **nexcue** and
**tabletap**, adapted to Tarmoto's conventions (TypeORM + PostGIS, pnpm
workspaces, `@tarmoto/*` packages, metric-only backend, `TARMOTO_` env prefix).

### Reference pattern (nexcue / tabletap)

Both siblings ship an `apps/admin` that is:

- **Vite + React 19 SPA** (not Next.js) deployed to a Cloudflare Worker.
- Authenticated via **GitHub OAuth SSO** with an env-gated password fallback for
  local dev.
- Backed by a **separate `admin_users` identity** (admins are not app users),
  with cookie-based JWT **access + rotating refresh** tokens and DB-backed
  sessions.
- Guarded by a NestJS `InternalGuard` + `@AdminRoles` decorator enforcing a
  **role rank**: `read_only (0) < support (1) < admin (2) < super_admin (3)`.
- Organized into flat `admin-*` backend modules with an `AdminAuditInterceptor`
  logging mutating actions.

The siblings use **Prisma**; Tarmoto uses **TypeORM**, so the schema is
translated to TypeORM entities. The SPA reuses their auth/refresh/guard
approach, talking to the backend through a generated typed OpenAPI client.

## 2. Goals & non-goals

### Goals (v1)

- A separate internal console at `apps/admin` (Vite + React SPA → Cloudflare
  Worker) with the four surfaces below.
- Admin identity + RBAC foundation (separate `admin_users`, sessions, refresh
  rotation, SSO, guard, role rank, audit log).
- A net-new feature-flag system (store + evaluation + admin CRUD + a public read
  contract for mobile/companion consumers).
- Geo-content moderation for POI, road closures (incl. detours), and mountain
  passes as **tabular CRUD + moderation** with a **read-only** map preview.

### Non-goals (v1)

- Map-based geometry editing (draw/move points and lines on a map). Detail views
  show a **read-only** MapLibre preview only; geometry edits are out of scope.
- Granular per-resource permissions beyond the 4-tier role rank.
- The "etc." surfaces (notification tooling, job control, full audit browser UI).
  The audit log is **written** in v1; a browsing UI is a follow-up.
- Any public-facing/consumer behavior change beyond the new feature-flag read
  contract.

## 3. Architecture

```
apps/admin/                              Vite + React 19 SPA → Cloudflare Worker (new)
  src/app/App.tsx                        auth gate + hash routing + layout shell
  src/auth/
    useAdminAuth.ts                      session hook + auth-expired window event
    adminAuthApi.ts                      login / me / logout / refresh / SSO endpoints
    LoginScreen.tsx                      GitHub SSO button + dev password fallback
  src/data/apiClient.ts                  openapi-fetch client + adminFetchWithRefresh
  src/screens/                           Overview, Users, FeatureFlags, Content/*
  src/components/{ui,layout}             Sidebar + TopBar (nexcue UX), tables, cards

apps/backend/src/modules/admin-*/        (new; mirrors sibling flat admin module shape)
  admin-auth/                            SSO, session + refresh-token rotation
  admin-users/                           list/search/detail/role-grant/suspend over `users`
  admin-feature-flags/                   net-new flag store + evaluation + CRUD
  admin-content/                         POI / road_closures / mountain_pass moderation
  internal/                              InternalGuard, @AdminRoles, role-rank, audit interceptor

apps/backend/src/entities/               (new TypeORM entities, translated from sibling Prisma)
  admin-user.entity.ts
  admin-session.entity.ts
  admin-refresh-token.entity.ts
  feature-flag.entity.ts
  feature-flag-override.entity.ts
  admin-audit-log.entity.ts

packages/openapi-client/                 regenerated to expose typed /admin/* paths to the SPA
```

> Note: per the `datasource-entity-list-split` learning, new entities must be
> registered in the runtime entity list in `database.module.ts`, not only in
> `data-source.ts`.

## 4. Foundation: identity, SSO & RBAC

This is the largest piece and everything else depends on it.

### Entities (TypeORM, translated from sibling Prisma)

- **`admin_users`** — admins are a **separate identity**, not `users` rows.
  - `id` (uuid), `email` (unique), `password_hash` (nullable; null = SSO-only),
    `role` (`read_only` | `support` | `admin` | `super_admin`),
    `status` (`active` | `disabled`), `sso_provider`, `sso_subject`
    (unique `(sso_provider, sso_subject)`), `last_login_at`, timestamps.
- **`admin_sessions`** — `id`, `admin_user_id`, `expires_at`, `revoked_at`,
  `last_seen_at`, timestamps.
- **`admin_refresh_tokens`** — `id`, `session_id`, `token_hash` (unique),
  `expires_at`, `revoked_at`, `replaced_by_token_id` (rotation chain),
  `last_used_at`, timestamps.
- **`admin_audit_log`** — `id`, `admin_user_id`, `admin_role`, `action`,
  `target_type`, `target_id`, `metadata` (jsonb), `created_at`.

Role rank constant: `{ read_only: 0, support: 1, admin: 2, super_admin: 3 }`.

### Auth & session

- Cookie-based JWT, HS256, payload carries `sid` + `scope`.
  - Access cookie `tarmoto_admin_access` (~9 min).
  - Refresh cookie `tarmoto_admin_refresh` (~30 days), rotating.
  - Cookies are `Secure`, `HttpOnly`, `SameSite=Lax`.
- Refresh tokens are stored **hashed**; rotation links old→new via
  `replaced_by_token_id`. Reuse of a rotated/revoked token revokes the chain.
- **SSO:** GitHub OAuth — `GET /admin/auth/sso/github/start` →
  `GET /admin/auth/sso/github/callback`. Env-gated password login for local dev
  only. **No open self-signup**: first login provisions a session only for an
  email already present as an `admin_user` (pre-seeded) or on an allowlist.
- Auth endpoints: `POST /admin/auth/login`, `POST /admin/auth/refresh`,
  `GET /admin/auth/me`, `POST /admin/auth/logout`.

### Guard & audit

- **`InternalGuard`** is applied to all `/admin/*` routes: extract access token
  from cookie (or `Authorization` header) → verify JWT → load a non-revoked,
  non-expired `admin_session` whose `admin_user.status = active` → set
  `request.adminUser`. Updates `last_seen_at`.
- **`@AdminRoles(role)`** decorator sets required role metadata; the guard
  enforces `actualRank >= requiredRank`. No decorator = any authenticated
  operator may call (used for reads).
- **`AdminAuditInterceptor`** records every mutating admin action to
  `admin_audit_log` with the acting admin, role, action, and target.

### Frontend auth

- `adminFetchWithRefresh` wraps fetch: on `401` it POSTs `/admin/auth/refresh`
  (deduplicated across concurrent requests) and replays the original request;
  on refresh failure it dispatches a `tarmoto-admin-auth-expired` window event.
  Refresh/login/logout paths are excluded from the retry loop; `/admin/auth/me`
  is **not** excluded (startup probe must be able to refresh) — matching
  tabletap's corrected behavior.
- `useAdminAuth`: on mount probes `/admin/auth/me`; listens for the expiry event
  to drop to the login screen. Exposes `{ status, user, error, login, logout }`.

### Secrets / config

- OAuth client id/secret, JWT signing secret, cookie names/domains via
  `TARMOTO_`-prefixed env (Node carve-outs `PORT`/`NODE_ENV` excepted).
- The Worker injects runtime config (`liveReadsEnabled`, `authRequired`,
  `passwordLoginEnabled`) consumed by the SPA, mirroring the sibling
  `__*_ADMIN_CONFIG__` pattern.

## 5. v1 Surfaces

### 5.1 Overview (Dashboard)

Landing screen proving the shell + live-reads plumbing: key counts (users,
active rides, pending content reports, total/enabled flags) via a single
`GET /admin/metrics` (or per-card endpoints). Read-only; visible to all roles.

### 5.2 User management

- Paginated, searchable, filterable list over the existing `users` table.
- Detail: profile, subscription status/tier, activity counts (rides, hazards,
  reviews, trips). **No password access.**
- Actions:
  - **Grant/revoke admin** — creates/disables an `admin_users` row for that
    person; `super_admin`-gated.
  - **Suspend / soft-delete** — uses existing `deleted_at` /
    `deletion_scheduled_at` fields; `support`+.
  - View subscription (read-only).

### 5.3 Feature flags (net-new)

- **`feature_flags`** — `key` (unique), `description`, `enabled` (bool),
  `rollout_percentage` (0–100), `kill_switch` (bool), timestamps.
- **`feature_flag_overrides`** — `flag_key`, `subject_type` (`user` | `cohort`),
  `subject_id`, `enabled`, timestamps. (Per-user / per-cohort pins.)
- **Evaluation service**: given a flag key + subject, returns a boolean —
  override > kill-switch > percentage bucket (stable hash of subject) > global
  `enabled`. **No silent default-on**: an unknown flag evaluates to a defined
  default (false) and is logged, not silently treated as enabled.
- **Public read contract**: `GET /feature-flags/evaluate` (or batched) for
  mobile/companion consumers — documented as a new contract for follow-up
  client wiring; this design adds the contract, not the consumer integrations.
- **Admin CRUD UI**: list flags, toggle `enabled`, set `rollout_percentage`,
  manage overrides. **Global kill-switch is `admin`-gated**; reads open to all
  operators.

### 5.4 Geo content moderation

Tabular CRUD + moderation over `poi` (poi module), `road_closures`,
`mountain_pass`:

- List/search/filter (incl. by status/source), paginated.
- Detail: editable fields + **read-only MapLibre static preview** of geometry.
  For `road_closures`, show `detour_geom` when present (roadworks only).
- Actions: edit fields, approve/reject/status transitions, delete.
- **Metric units preserved end-to-end** — the admin must not write non-metric
  values; any display conversion happens in the client only, never persisted
  (per repo metric-only rule).

## 6. Data flow, errors, contracts, testing

### Data flow

SPA → typed `@tarmoto/openapi-client` over `/admin/*` → `InternalGuard`-guarded
NestJS controllers → services → TypeORM/PostGIS. React Query (TanStack v5) for
reads and mutations; `adminFetchWithRefresh` handles 401→refresh→replay
transparently.

### Error handling

- No silent fallbacks (per AGENTS.md). Guard failures return `401`/`403`,
  surfaced in the UI as a login bounce or a permission notice.
- Feature-flag evaluation failures are explicit and logged, never defaulted to
  "on".
- Content moderation enforces existing service invariants (e.g. `detour_geom`
  only valid for `reason = 'roadworks'`).

### Contracts

- Every new endpoint flows through DTOs → OpenAPI spec (`@tarmoto/openapi`) →
  regenerated `@tarmoto/openapi-client`, keeping backend and SPA in sync.
- The new feature-flag read contract is documented for the mobile/companion
  follow-up; shared enums/types belong in `@tarmoto/shared`.

### Testing

- Backend unit/integration: `InternalGuard` (auth + role rank), session +
  refresh-token rotation/reuse, SSO callback provisioning, flag evaluation
  (override/kill-switch/percentage/default), content moderation transitions,
  audit interceptor writes.
- SPA component tests (Vitest, matching companion setup): auth gate, refresh
  replay, and one table screen (list + filter + action).
- `db:seed` seeds at least one `super_admin` for local dev.

## 7. Deployment

`apps/admin` deploys to a **new Cloudflare Worker** (consistent with the
siblings and the existing companion / poc-sensor Cloudflare setup): `wrangler`
config, `build` = `tsc -b && vite build`, dev server on a dedicated port (e.g.
3004, after backend 3000 / marketing 3001 / companion 3002). Add
`admin:dev` / `admin:build` workspace scripts.

## 8. Phasing (one spec → multiple implementation plans)

1. **Foundation** — admin entities + migration (registered in
   `database.module.ts`), `admin-auth` + GitHub SSO + `InternalGuard` +
   `@AdminRoles` + role rank + `AdminAuditInterceptor`; scaffold `apps/admin`
   shell + `LoginScreen` + `useAdminAuth` + `apiClient` + **Overview**. Seed a
   `super_admin`. (Largest; everything depends on it.)
2. **User management** — list/detail/role-grant/suspend.
3. **Feature flags** — backend store + evaluation + public read contract + CRUD
   UI.
4. **Geo content moderation** — POI / closures / passes tabular CRUD + read-only
   preview.

## 9. Key assumptions (flagged per AGENTS.md)

- **GitHub OAuth** is the staff SSO provider (matching siblings). Requires a
  GitHub OAuth app for Tarmoto; until provisioned, dev-password login is the
  fallback and the SSO wiring ships behind config.
- Admins are a **separate `admin_users` identity**, not a flag on `users`.
- `apps/admin` deploys as a **new Cloudflare Worker**, separate from the
  companion, giving a clean access boundary (no admin code in the public
  bundle).
- v1 geo moderation is **tabular**; interactive map geometry editing is a
  deliberate follow-up.
