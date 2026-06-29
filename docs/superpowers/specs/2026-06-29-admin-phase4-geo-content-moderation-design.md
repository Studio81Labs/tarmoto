# Tarmoto Admin — Phase 4: Geo-Content Moderation — Design

- **Date:** 2026-06-29
- **Status:** Approved (design); pending implementation plan
- **Builds on:** Phase 1 admin console (#718), `@tarmoto/ui` adoption (#720), `create-admin` CLI (#721), Phase 2 User & Admin Management (#722), Phase 3 Feature Flags (#738) — all merged to `main`.
- **Scope:** A **proactive, admin-only Geo-Content Moderation** surface. Operators browse, search, and moderate user-generated content (hazard reports, road reviews, trip messages) — hiding/restoring it (reversible) or hard-deleting it (irreversible) with a captured reason. This is the second schema-bearing admin phase (it adds a migration that extends three existing tables).

## 1. Background & motivation

Phases 1–3 delivered the admin foundation (separate `admin_users` identity, cookie JWT sessions, GitHub SSO, `InternalGuard` + role rank, audit log/interceptor, `setAdminAuditTarget`), the `@tarmoto/ui`-styled SPA shell with role-gated routes (`roleRank.ts` `canAccess`), User & Admin management, and Feature Flags.

There is **no content-moderation or user-reporting infrastructure today** — this is greenfield. The SPA already ships a `content` route stub (`{ key: "content", label: "Content" }` in `apps/admin/src/app/routes.ts`) with no screen behind it. This phase fills that stub and gives operators a way to pull abusive or low-quality crowdsourced content out of the public surfaces without a deploy.

The product is built on crowdsourced road-surface intelligence and hazard alerts, so the moderate-able content is the free-text/photo, user-authored content that reaches other riders: **hazard reports** (`note` + `photo_url`), **road reviews** (`comment` + `photos[]`), and **trip messages** (`body`). Sensor data (surface readings), computed zones (fun zones), and operator-entered closures are out of scope — they are not user-authored free content.

## 2. Goals & non-goals

### Goals

- A dedicated **moderation column set** (`moderation_status`, `moderation_reason`, `moderated_by`, `moderated_at`) added to `hazard_reports`, `road_reviews`, and `trip_messages` via a TypeORM migration.
- **Public-feed exclusion**: every end-user read path for these three types filters out `moderation_status = 'hidden'`.
- A single **`admin-content`** backend module (Approach A — type registry) exposing browse/search + hide/restore/delete over a normalized item shape.
- Admin SPA **Content** screen: type tabs, status filter, text search, paginated table, per-row hide (with reason) / restore / delete, author link-out to the Phase 2 Users surface.
- An optional Overview `hiddenContent` count tile.
- Full audit coverage on mutations (reuses `AdminAuditInterceptor` + `setAdminAuditTarget`).

### Non-goals (this phase)

- **User-facing reporting / flagging** (mobile or companion "Report" actions, a `content_reports` intake table, a report-resolution queue) — explicitly deferred to a possible later phase. This phase is proactive admin-driven only; no mobile/companion changes.
- **Author sanctions in this surface** (warn / suspend / ban the author). The author is surfaced and deep-linked to the Phase 2 Users surface; sanction actions stay there and are not duplicated here.
- **Moderating non-authored content** — surface readings (sensor/ML), fun zones (computed), road closures (operator-entered), rides/trips themselves.
- **A `pending`/pre-moderation state.** Content is `visible` by default (published immediately, as today); moderation is reactive to operator review, not a gate. Statuses are `visible` and `hidden` only.
- **Shared-package additions.** The moderation contract is admin-only; it flows through OpenAPI to the generated client. Nothing is added to `@tarmoto/shared`.

## 3. Architecture

```
apps/backend/src/migrations/<ts>-AddContentModeration.ts      (new) ALTER 3 tables + indexes
apps/backend/src/entities/hazard-report.entity.ts             (edit) + 4 moderation columns
apps/backend/src/entities/road-review.entity.ts               (edit) + 4 moderation columns
apps/backend/src/entities/trip-message.entity.ts              (edit) + 4 moderation columns

apps/backend/src/modules/hazards/hazards.service.ts           (edit) exclude hidden from active feed
apps/backend/src/modules/reviews/reviews.service.ts           (edit) exclude hidden from list + aggregates
apps/backend/src/modules/<trip>/...                           (edit) exclude hidden from message fetch

apps/backend/src/modules/admin-content/                       (new — Approach A)
  admin-content.controller.ts   GET /admin/content, POST .../:type/:id/hide,
                                POST .../:type/:id/restore, DELETE .../:type/:id
  admin-content.service.ts      list / hide / restore / delete via CONTENT_TYPES registry
  content-types.ts              CONTENT_TYPES registry (type -> entity/textCol/photos/location/auditType)
  dto/admin-content.dto.ts      ContentItemDto, ContentListDto, ListContentQueryDto, HideContentDto

apps/backend/src/modules/admin/admin.module.ts                (edit) register controller+service+entities
apps/backend/src/modules/admin/admin-metrics.service.ts       (edit) optional hiddenContent count

apps/admin/src/data/useAdminContent.ts                        (new) $api hooks
apps/admin/src/screens/ContentScreen.tsx                      (new) tabs + filter + search + table + actions
apps/admin/src/app/routes.ts                                  (edit) content -> minRole: 'support'
apps/admin/src/app/App.tsx                                    (edit) render ContentScreen

packages/openapi-client/src/generated/schema.d.ts             (regenerated) new paths
```

All `/admin/*` routes are already covered by the global `InternalGuard` (auth + role rank) and `AdminAuditInterceptor` (mutation auditing). The new endpoints add `@AdminRoles('support')` (browse/hide/restore) and `@AdminRoles('admin')` (delete); mutations call `setAdminAuditTarget`.

## 4. Data model

Add the same four columns to **`hazard_reports`**, **`road_reviews`**, and **`trip_messages`**:

| Column              | Type                   | Notes                                                 |
| ------------------- | ---------------------- | ----------------------------------------------------- |
| `moderation_status` | `varchar(16) NOT NULL` | default `'visible'`; values `'visible'` \| `'hidden'` |
| `moderation_reason` | `varchar(500)` NULL    | captured on hide; cleared on restore                  |
| `moderated_by`      | `uuid` NULL            | FK → `admin_users(id)` `ON DELETE SET NULL`           |
| `moderated_at`      | `timestamptz` NULL     | set on hide; cleared on restore                       |

Per-table composite index `(moderation_status, created_at)` to support the admin listing (filter by status, order by recency descending).

**Decisions:**

- A **dedicated** `moderation_status` column rather than overloading `HazardReport.is_active` — `is_active` already encodes auto-expiry; conflating "expired" with "hidden by a moderator" would corrupt both the public-feed logic and the audit trail.
- `DEFAULT 'visible'` makes the migration behavior-preserving: all existing rows stay visible.
- **Restore clears `moderation_reason`/`moderated_by`/`moderated_at`** so the columns always mean "currently-active moderation," not "last moderated by." The historical record of who hid/restored what lives in the audit log.
- Hard delete removes the row; no soft-delete column is added for it.
- `down()` drops the indexes and columns from all three tables.

## 5. Surfaces & endpoints

### 5.1 Normalized contract

A single normalized projection across the three heterogeneous types:

```
ContentItemDto {
  type: 'hazard' | 'review' | 'trip_message'
  id: string
  authorId: string | null            // user_id; null if author user was deleted
  authorName: string | null          // display name/email from users join
  text: string | null                // note / comment / body
  photoUrls: string[]                // hazard: [photo_url] if set; review: photos ?? []; message: []
  createdAt: string
  status: 'visible' | 'hidden'
  moderationReason: string | null
  moderatedAt: string | null
  location: { lat: number; lng: number } | null   // hazard only; review/message: null
}

ContentListDto { items: ContentItemDto[]; total: number; page: number; pageSize: number }
```

### 5.2 Admin → Content (operators)

All under the global `InternalGuard`; mutations auto-audited.

- `GET /admin/content` — query params:
  - `type` **required**, enum `hazard | review | trip_message`; unknown → **400**.
  - `status` ∈ `visible | hidden | all`, default `all`.
  - `q` optional free-text; trimmed, length-bounded; `ILIKE` on the registry-defined text column (`%`/`_` escaped). The text column is registry-sourced, never user input → injection-safe.
  - `page` default 1; `pageSize` default 25, max 100.
  - Role `support`+. Returns `ContentListDto`, ordered `created_at DESC`. Joins `users` for author name.
- `POST /admin/content/:type/:id/hide` — body `{ reason?: string (≤500) }`. Role `support`+. Sets `moderation_status='hidden'`, `moderation_reason`, `moderated_by` (acting admin), `moderated_at=now`. **404** if id not found; unknown `type` → **400**. `setAdminAuditTarget(req, { target_type: <auditType>, target_id: id })`. Returns the updated `ContentItemDto`.
- `POST /admin/content/:type/:id/restore` — Role `support`+. Sets `moderation_status='visible'`, clears `moderation_reason`/`moderated_by`/`moderated_at`. **404** if not found. Audit target set.
- `DELETE /admin/content/:type/:id` — Role `admin`+. Hard delete. **204** on success; **404** on zero-affected. Audit target set.

`auditType` per type: `hazard_report`, `road_review`, `trip_message`.

### 5.3 Overview metric (optional)

`AdminMetricsService.snapshot()` gains `hiddenContent` = sum of `moderation_status='hidden'` counts across the three tables, surfaced as a glanceable tile. Part of the existing `GET /admin/metrics` (already gated).

## 6. Public-feed exclusion (regression surface)

Adding the column is inert unless the end-user read paths filter on it. Each of these is a behavior change to an existing module and gets a regression test asserting a hidden row disappears:

- **Hazards** — `HazardsService` active-hazard query adds `AND hr.moderation_status = 'visible'` (alongside the existing `is_active = true AND expires_at > NOW()`).
- **Reviews** — `ReviewsService` review **list** excludes hidden, and the **rating aggregate** excludes hidden (a hidden review must not skew a road segment's average).
- **Trip messages** — the message-fetch path excludes hidden.

## 7. Authorization model

- **Content surface:** `support`+ for browse/hide/restore; `admin`+ for hard delete. The SPA route carries `minRole: 'support'`, so `read_only` sees neither the nav item nor the screen; the delete control renders only for `admin`+ via `canAccess`.
- **Author actions:** out of scope here; the row deep-links to the Phase 2 Users surface where sanctions live.
- **Trip-message privacy (flagged risk):** browsing/searching `trip_message` exposes private group-chat content to `support`-level operators. Included per explicit product decision. Reads are not audited (the interceptor audits mutations only), consistent with the rest of the admin read surfaces. Auditing trip-message reads specifically is a possible later follow-up, not in this phase.

## 8. Data flow, errors, contracts, testing

- **Data flow:** Admin SPA → typed `@tarmoto/openapi-client` over `/api/v1/admin/content...` → guarded controller → `admin-content.service` → registry-resolved TypeORM repository (query builder with `users` join, status filter, escaped `ILIKE`, `getManyAndCount` for pagination). React Query for reads + mutations.
- **Errors:** no silent fallbacks — unknown `type` → `400`, id not found → `404`, with explicit messages surfaced via the Phase-2 `statusCode`/`message` pattern.
- **Contracts:** new DTOs → OpenAPI (`@tarmoto/openapi`) → regenerated `@tarmoto/openapi-client`. SPA uses the prefixed `/api/v1/...` paths and types rows from the generated `components`. No `@tarmoto/shared` change.
- **Migration:** raw-SQL TypeORM migration, runnable up and down (`pnpm db:migrate`), registered in both `data-source.ts` (guarded by `migration-registry.spec.ts`) and `database.module.ts`. Documented in the change.
- **Tests:**
  - Backend: service projection per type (text/photo/location/author mapping), `status` filter, escaped `ILIKE` search, pagination (`total` + page bounds), `created_at DESC` ordering; hide sets `moderated_by`/reason/timestamp; restore clears them; delete `204` + `404` on missing; unknown type `400`; controller gating (`support` denied delete; `read_only` denied all); audit-target wiring per action; **public-path regression tests** (hidden item excluded from hazards feed / reviews list + rating aggregate / trip-message fetch); migration up/down.
  - SPA: the screen renders rows per type from mocked hooks; tab switch + status filter + search wire to the right query params; hide/restore/delete invoke the right endpoints and refetch; the delete control is hidden for `support`; the route is gated (`support`+ — hidden/access-denied for `read_only`); server errors surfaced.

## 9. Implementation slices (one spec → ~4 plan sections)

1. **Backend — schema:** migration (3× `ALTER TABLE` + composite indexes, registered in both data-source files) + the four moderation columns on each of the three entities.
2. **Backend — public-feed exclusion:** add `moderation_status = 'visible'` filtering to the hazards active feed, the reviews list + rating aggregate, and the trip-message fetch + regression tests. (Sequenced right after schema; the `'visible'` default keeps behavior unchanged until a hide occurs.)
3. **Backend — admin-content module:** `CONTENT_TYPES` registry + service (list/hide/restore/delete) + DTOs + controller (validation, role gating, audit target) + register in `AdminModule` + optional Overview `hiddenContent` metric + regenerate OpenAPI + tests.
4. **SPA — Content screen:** `useAdminContent` hooks + `ContentScreen` (type tabs, status filter, debounced search, paginated table, hide-with-reason / restore / role-gated delete, author link-out) + route `minRole: 'support'` + render in `App` + tests.

## 10. Key assumptions (flagged)

- Proactive admin-only moderation; no user-facing reporting and no mobile/companion changes this phase.
- Three content types: hazard reports, road reviews, trip messages. Sensor/computed/operator content is out of scope.
- Statuses are `visible`/`hidden` only — no pre-moderation `pending` state; content publishes immediately as today.
- Hide/restore is reversible; hard delete is irreversible and gated to `admin`+.
- Restore clears the moderation columns; history lives in the audit log.
- Browsing trip messages exposes private chat to `support`+ operators (accepted); reads are unaudited, consistent with other admin read surfaces.
- `key`-style immutability is not relevant here; `type`+`id` identify a content item and `type` is validated against the registry whitelist.
- No production-deploy work here (the admin prod deployment remains a tracked follow-up from Phase 1).
