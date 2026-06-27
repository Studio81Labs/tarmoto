# Tarmoto Admin — Phase 2: User & Admin Management — Design

- **Date:** 2026-06-27
- **Status:** Approved (design); pending implementation plan
- **Builds on:** Phase 1 admin console (#718), `@tarmoto/ui` adoption (#720), `create-admin` CLI (#721) — all merged to `main`.
- **Scope:** Two admin console surfaces — **Users** (app customers) and **Administrators** (staff) — with browse + lifecycle actions, on the existing admin module + SPA shell.

## 1. Background & motivation

Phase 1 delivered the admin foundation (separate `admin_users` identity, cookie JWT sessions with jar-bound rotating refresh, GitHub SSO, `InternalGuard` + role rank, audit log, an Overview metrics screen) and a Vite + React SPA shell styled with `@tarmoto/ui`. Admin accounts are provisioned via the `create-admin` CLI.

This phase adds the first management surfaces:

- **Admin → Users** — operate on the app's customers (`users` table): find accounts, inspect them, and soft-delete / restore.
- **Admin → Administrators** — operate on staff accounts (`admin_users`): list, create (UI counterpart to the CLI), change role, enable/disable.

The remaining v1 surfaces — feature flags (Phase 3) and geo-content moderation (Phase 4) — are out of scope here.

## 2. Goals & non-goals

### Goals

- A paginated, searchable **Users** list + detail, with **soft-delete and restore** (reusing the existing `deleted_at` / account-deletion machinery — no new schema).
- An **Administrators** list with **create** (password or SSO-only), **change role**, and **enable/disable**, gated by the role rank, with session revocation on disable/demote.
- Role-rank authorization and safety rails (no self-lockout; protect the last `super_admin`).
- Full success + denied auditing (the audit interceptor already records mutating `/admin/*` calls; the guard already records `insufficient_role` denials).

### Non-goals (this phase)

- A "suspend/disable" capability for **app users** (would need a new `users` column + auth-guard change) — deferred; only soft-delete/restore here.
- Editing app-user profile fields, subscription management, or impersonation.
- Feature flags (Phase 3), geo-content moderation (Phase 4).
- Admin production deployment (Worker `/api/v1` proxy + deploy workflow) — still a tracked follow-up from Phase 1.

## 3. Architecture

```
apps/backend/src/modules/admin-users/        (new — app-customer management)
  admin-users.controller.ts                  GET /admin/users, GET /admin/users/:id,
                                             DELETE /admin/users/:id, POST /admin/users/:id/restore
  admin-users.service.ts                     list/search/paginate, detail+activity counts, soft-delete/restore
  dto/admin-users.dto.ts
apps/backend/src/modules/admin-admins/       (new — staff management)
  admin-admins.controller.ts                 GET /admin/admins, POST /admin/admins,
                                             PATCH /admin/admins/:id
  admin-admins.service.ts                    list, create, role/status change (+ session revoke)
  dto/admin-admins.dto.ts
apps/backend/src/modules/admin/admin.module.ts   register the two new controller/service sets + entities
apps/backend/src/scripts/create-admin-core.ts    REUSED by admin-admins.service (shared upsert/revoke logic)

apps/admin/src/screens/UsersScreen.tsx           Users list + detail + actions
apps/admin/src/screens/AdministratorsScreen.tsx  Admins list + create + role/status
apps/admin/src/data/useAdminUsers.ts             $api hooks (list/detail/mutations)
apps/admin/src/data/useAdminAdmins.ts
apps/admin/src/app/routes.ts                     add `administrators` route; wire `users`

packages/openapi-client/src/generated/schema.d.ts   regenerated for the new /admin/* paths
```

All `/admin/*` routes are already covered by the global `InternalGuard` (auth + role rank) and `AdminAuditInterceptor` (mutation auditing). New endpoints add `@AdminRoles(...)` where a minimum rank applies and enforce `canManageAdminRole` in the service for per-target admin checks.

### Reuse: the `create-admin` core

The admin-admins service reuses `runCreateAdmin` (and its helpers) from `create-admin-core.ts` for create/update so the UI and CLI share identical behavior: password hashing, SSO-only rows, the no-self-signup / different-identity guards, and **session revocation on credential change or disabled→active reactivation**. If the core's signature needs light adjustment to be callable from a NestJS service (e.g. accept an `EntityManager` — it already does), make that adjustment without changing CLI behavior.

## 4. Surfaces & endpoints

### 4.1 Admin → Users (app customers)

- `GET /admin/users` — paginated list. Query: `q` (email/display_name substring), `subscription` (tier/status filter), `deleted` (active | deleted | all), `page`/`pageSize`, sort by created_at. Returns rows: id, email, display_name, subscription_tier, subscription_status, created_at, deleted_at.
- `GET /admin/users/:id` — detail: profile (email, display_name, home_region, created_at, email_verified_at), subscription (tier, status, current_period_end, cancel_at_period_end), deletion state (deleted_at, deletion_scheduled_at, deletion_reason), and **activity counts** (rides, hazard_reports, road_reviews, trips, commute_routes) via `COUNT` queries (bounded; no unbounded row fetch). Never returns `password_hash` (it's `select:false`).
- `DELETE /admin/users/:id` — soft-delete via the existing account-deletion path (sets `deleted_at`; the auth guard already blocks soft-deleted users from the app). Idempotent; 404 if not found.
- `POST /admin/users/:id/restore` — clear `deleted_at` / `deletion_scheduled_at` to reactivate.
- **Gating:** all of the above require **`support`+**.

### 4.2 Admin → Administrators (staff)

- `GET /admin/admins` — list admin_users: id, email, role, status, last_login_at, created_at. (No password material.)
- `POST /admin/admins` — create: `{ email, role, mode: 'password' | 'sso-only', password? }`. Reuses the create-admin core (upsert by email; password hashed; sso-only → null hash). **Gating:** `admin`+ AND `canManageAdminRole(actor, role)`.
- `PATCH /admin/admins/:id` — change `role` and/or `status` (active|disabled). On disable or demotion (or any credential change), **revoke the target's active sessions + refresh tokens** (reuse the core's revoke). **Gating:** `admin`+ AND `canManageAdminRole(actor, currentTargetRole)` AND, for role changes, `canManageAdminRole(actor, newRole)`.
- **Safety rails (enforced server-side, tested):**
  - An admin cannot disable or demote **their own** account (`target.id === actor.id` → 403).
  - The **last active `super_admin`** cannot be disabled or demoted (→ 409/422 with a clear message).

## 5. Authorization model (summary)

- `support` (rank 1) and above → Users surface (view + soft-delete/restore).
- `admin` (rank 2) and above → Administrators surface (view); per-target mutations additionally require `canManageAdminRole(actor, target)` (actor rank strictly greater than the target role rank). Net effect: only a `super_admin` can create/modify `admin` or `super_admin` accounts; an `admin` can manage `support`/`read_only` only.
- Denials return 403 and are already recorded as `insufficient_role` by the guard; service-level rejections (self-lockout, last-super-admin) return a 4xx with an explicit reason and are recorded by the audit interceptor.

## 6. Data flow, errors, contracts, testing

- **Data flow:** SPA → typed `@tarmoto/openapi-client` over `/api/v1/admin/...` → guarded controllers → services → TypeORM/PostGIS; React Query for reads + mutations.
- **Errors:** no silent fallbacks; not-found → 404, forbidden → 403, safety-rail violations → explicit 4xx with a message the SPA surfaces (e.g. via `Alert`).
- **Performance:** list endpoints are paginated with bounded `pageSize`; detail activity uses `COUNT` aggregates (no N+1, no unbounded fetch).
- **Contracts:** new DTOs → OpenAPI (`@tarmoto/openapi`) → regenerated `@tarmoto/openapi-client`; shared enums/types (roles) come from existing definitions. SPA uses the prefixed paths.
- **Tests:**
  - Backend: list (search/filter/pagination), detail (activity counts), soft-delete + restore; admin list/create/role-change/disable; rank gating (allowed + forbidden per role); safety rails (self-demote, last-super-admin); session revocation on disable/demote; audit rows for mutations + denials.
  - SPA: both screens render lists from mocked hooks; actions invoke the right endpoints; role-gated controls are hidden/disabled for insufficient roles.

## 7. Implementation slices (one spec → ~4 plan sections)

1. **Backend — Users API**: list/detail/soft-delete/restore + DTOs + tests; register in `AdminModule`; regenerate OpenAPI.
2. **Backend — Administrators API**: list/create/patch reusing the create-admin core + rank gating + safety rails + session revocation + tests; regenerate OpenAPI.
3. **SPA — Users screen**: list (search/filter/paginate) + detail + soft-delete/restore actions + hooks + tests; wire the `users` route.
4. **SPA — Administrators screen**: list + create (password/sso-only) + role/status controls (role-gated) + hooks + tests; add the `administrators` sidebar route.

## 8. Key assumptions (flagged)

- App-user "suspend" is **not** in scope — only soft-delete/restore (no new `users` column).
- Admin management is rank-gated (`admin`+ with `canManageAdminRole`); the `create-admin` CLI remains available for headless/prod bootstrap.
- Disabling/demoting an admin revokes their sessions (consistent with the CLI's credential/reactivation revoke).
- No production deploy work here (deferred follow-up from Phase 1).
