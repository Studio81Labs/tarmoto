# Feature Flags & Tier Entitlements

Tarmoto gates premium features with a tier-aware feature-flag system,
implemented the same way as its sibling projects (nexcue, tabletap): the
flag vocabulary is **code-defined**, the database stores **only override
state**, and every gated endpoint re-resolves **live** so an operator kill
switch takes effect immediately.

## Registry (source of truth)

`packages/shared/src/feature-flags.ts` — `FEATURE_DEFINITIONS` (keyed by
flag), with `FEATURE_KEYS` / `TOGGLE_FEATURE_KEYS` / `LIMIT_FEATURE_KEYS`
derived from it. Operators cannot invent keys at runtime; adding a flag or
limit is a code change:

1. add the entry to `FEATURE_DEFINITIONS` (`kind: "toggle" | "limit"`),
2. add the matching field to the snapshot DTO — `FeatureSnapshotDto`
   (`.../features/dto/feature-snapshot.dto.ts`) for a toggle, or
   `LimitSnapshotDto` (`limit-snapshot.dto.ts`) for a limit — the
   compile-time shape guard fails the build if you forget,
3. regenerate OpenAPI (`pnpm openapi:gen`).

Removing or renaming a key needs a migration that fixes the affected
override rows (`feature_states` / `limit_states` for globals,
`user_features` / `user_limits` for per-user) — see
`1814-AlignFeatureFlagCatalog` for the pattern.

The full flag/limit vocabulary is catalogued in
[`docs/feature-flags.md`](../feature-flags.md) (the source-of-truth list,
with per-tier values and kill-switch scenarios). Tier naming (decided
2026-07, swapping the original marketing copy): **Pro is the €29.99 mid
tier, Premium the €49.99 top tier.**

Definitions carry a `kind` (`toggle` | `limit`), a description, a
baseline `default`, and per-tier values. Toggles use a tier allowlist
(only ever flips ON); limits carry an explicit per-tier number (`null` =
unlimited). Only the keys below have **live server-side enforcement** —
every other key is registry vocabulary that gates UI client-side (or is
not built yet); defining a key does not gate a feature until a guard or
limit check is wired.

**Enforced toggles:**

| Key                | Tiers                             | Gated surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gpx_export`       | pro, premium                      | **Backend (server-enforced):** `GET /rides/export.gpx` + `GET /rides/:rideId/gpx`. **Mobile:** recorded-ride export (`RideDetailScreen` / `SettingsScreen` bulk — proactive client gate + 403 safety net on those endpoints, owner-only) and **planned-trip GPX** (`TripDetailScreen` — rendered client-side, **NO server guard**, so client gate is the only enforcement). **Companion:** planned-trip GPX (`TripExportButton` — client-side)                                                                                                                                                                                                                                                                                                                                                                           |
| `commuter_mode`    | pro, premium                      | the whole `/commute/*` controller                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `group_rides`      | premium                           | `/group-rides` create/join/detail + the socket rooms; `leave`/`end` stay open so a revoked rider can still clean up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `hazard_reporting` | all (free — operator kill switch) | **Backend (server-enforced):** `@RequireFeature('hazard_reporting')` on `POST /hazards` + `POST /hazards/photos` — the 403 `FeatureForbiddenDto` carries a machine-readable `feature` plus a `scope` (`"global"` for an operator `force_off`, `"user"` for a per-user override). Also gated client-side on mobile; the mobile offline queue RETAINS the report only on a **`scope: "global"`** 403 (temporary operator kill — `isHazardReportingKilledError` matches `scope !== "user"`), and PROPAGATES a **`scope: "user"`** 403 (a persistent per-user revocation that will never lift) so the report isn't silently queued to age out.                                                                                                                                                                               |
| `gpx_import`       | all (free — operator kill switch) | **Backend (server-enforced):** `@RequireFeature('gpx_import')` on `POST /rides/import`, `POST /trips/import`, `PUT /trips/:tripId/import` — 403 `FeatureForbiddenDto` on `force_off`. **Mobile:** also client-gated (`TripCreateScreen` hides the Import action and re-checks the `gpx_import` kill switch before opening the picker and before the POST). **Companion:** ALSO client-gated (since #1105) — `TripImportDialog` consults `/config/flags` and, on `force_off`, refuses to open, refuses to START a parse for a drag-and-dropped file, and invalidates an in-flight one so a pending `file.text()` cannot reach `parseImportedRoute`. This matters for incident response: a `force_off` now stops the in-browser parser, not just the backend save, so the switch is usable against a parser vulnerability. |

**Enforced limits:**

| Key                      | Free | Pro/Premium                | Gated surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `max_active_trips`       | `1`  | `null` (∞)                 | trip create / import / duplicate / clone + every completed→open promotion (`TripsService.assertCanMintOpenTrip`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `max_trip_collaborators` | `0`  | `5` pro / `null` ∞ premium | trip collaborator invites (`TripsService.assertCanAddCollaborator`) + public group-link joins (`TripSharesService.joinByToken`, serialised per-trip under an advisory lock)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `road_quality_max_zoom`  | `12` | `null` (∞)                 | Road-quality overlay zoom clamp — **client-side on both platforms** (the shared `clampQualityMaxZoom` fed to the MapLibre layer `maxzoom`): **companion** `/explore` + planner (`resolveQualityLayerMaxZoom` / `MapCanvas`, `/config/limits` map for anonymous viewers) and **mobile** `MapScreen` overlay (`MOBILE_QUALITY_CEILING` = `22`, the mobile tile source's real max — companion's is `18`). Both resolve the anonymous case from the public `/config/limits` map (the map tab + quality tiles are public on both). **Backend (server-side backstop, #1108):** `GET /roads/tiles/:z/:x/:y.mvt` (`TilesService.qualityAllowedAtZoom`) withholds the quality layer beyond the requester's resolved cap — authenticated requests always (resolved per-user; no live client authenticates tile fetches yet), anonymous requests against the free-tier cap only once `TARMOTO_TILES_ANON_QUALITY_ZOOM_CLAMP_ENABLED=true` (**keep off until tile fetches carry identity** — both clients' MapLibre sources and the mobile offline-pack downloader, which caches quality tiles to z16, fetch anonymously, so an early flip severs paying riders' deep-zoom overlay and offline packs the moment the 1818 launch seed is cleared) |
| `hazard_reports_per_day` | `50` | `50` (flat, all tiers)     | **Backend (server-enforced):** `POST /hazards` (`HazardsService.create`) counts the caller's reports over a rolling 24h window and rejects at the cap with the `FEATURE_LIMIT_EXCEEDED` 403. An anti-abuse rate cap, not a pricing lever — `0` doubles as a reporting kill switch. NOT seeded dark (enforced immediately); no launch override to clear                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

All other catalog keys (the remaining 16 toggles + 2 limits) resolve into
the snapshot but have no enforcement yet. `commuter_mode` is not on the
pricing card but is a Pro-tier feature per the product spec §Monetization.
`road_quality_max_zoom` is enforced on the client (the overlay ceiling, on
**both** companion and mobile) with a server-side tile backstop whose
anonymous leg ships dark behind
`TARMOTO_TILES_ANON_QUALITY_ZOOM_CLAMP_ENABLED` — see the table row above.
`gpx_export` is server-enforced for recorded rides but is a **client-only**
gate for planned-trip GPX (companion `TripExportButton`, mobile
`TripDetailScreen`), which is generated in-app with no backend round trip.

## Resolution precedence

`resolveFeature` (pure, in `@tarmoto/shared`), low → high:

1. registry `default`
2. **tier grant** — allowlist, only ever flips a flag ON
3. **per-user override** (`user_features` row; `enabled` grants or revokes)
4. **global override** (`feature_states` row): `force_off` is an absolute
   kill switch; `force_on` enables for everyone except an explicit
   per-user force-off

## Storage

- `user_features` — one row per (user, feature) override; row presence is
  the override, absence means normal resolution. FK cascades on user
  deletion.
- `feature_states` — one row per feature with an active global override
  (`state`, mandatory `reason` for `force_off`, `updated_by` admin id).
  The `reason` is stored here and deliberately **kept out of the audit
  log** (free-form text may contain user details).

Flags whose feature is already live and open to everyone (`gpx_export`,
`commuter_mode`, `group_rides`) were seeded `force_on` by migration 1795 so
introducing tier gating changed nothing for current users. Clear the overrides
(`DELETE /admin/feature-flags/:feature/global`) when tier enforcement
should go live. The enforced limits ship dark the same way — a launch-mode
global row (`limit_states`, value `NULL` = unlimited) that an operator clears
to activate the free-tier cap:

- `DELETE /admin/feature-limits/max_active_trips/global` → `free = 1`
  (seeded by migration `1813`)
- `DELETE /admin/feature-limits/max_trip_collaborators/global` → `free = 0`
  (pro `5`, premium ∞; seeded by migration `1818`)
- `DELETE /admin/feature-limits/road_quality_max_zoom/global` → `free = 12`
  (seeded by migration `1818`)

Clear all three to fully activate the tier caps at monetization go-live.

> `road_quality_full_zoom` has since been **retired** from the registry too
> — the `road_quality_max_zoom` limit is the single zoom-depth enforcement
> point, so the boolean was pure duplication. (It was itself a rename of
> `full_road_quality_zoom` → `road_quality_full_zoom` in migration
> `1814-AlignFeatureFlagCatalog`; its 1796 launch `force_on` row is now an
> inert orphan.) `unlimited_trip_planning` was likewise retired (superseded
> by `max_active_trips`). Admin requests against any of these keys are
> rejected as unknown features. The retired flags' old override rows are
> left in the tables as inert orphans (the resolver ignores unregistered
> keys) rather than deleted, so a rollback can restore prior behavior.

Keys with no override row (the newly-added catalog flags/limits, and flags
for not-yet-built features) resolve purely by tier from day one.

## Launch mode (auto-grant tier)

The sibling `launch_all_pro` pattern, generalised to a tier picker:
`app_settings` key `launch_tier` (`pro` | `premium`; no row = off). While
set, every **new registration** is created on that tier with
`users.plan_source = 'founder'`, so early-adopter grants stay
distinguishable from paid subscriptions. Existing accounts are never
modified; turning launch mode off does not revoke prior grants.

- Admin API: `GET/PUT /admin/system-settings/launch-tier`
  (read: support role; write: admin role, audited)
- Admin console: "Launch mode" card on the Feature Flags screen

## Backend enforcement

`apps/backend/src/modules/features/` — `FeatureResolver` (live DB
resolution, no cache), `FeatureGuard` + `@RequireFeature(key)` (403
`Feature unavailable: <key>` when off). Pair the guard **after**
`AuthGuard`:

```ts
@UseGuards(AuthGuard, FeatureGuard)
@RequireFeature('gpx_export')
```

## Delivery to clients

- **Authenticated:** `UserResponseDto` (`/users/me`, `/auth/login`,
  `/auth/register`, `/auth/refresh`) carries `subscription_tier`, a
  resolved `features` snapshot (booleans) and a `limits` snapshot
  (numbers, `null` = unlimited). Clients gate UI from `user.features`
  (`isFeatureEnabled(features, key)`) and `user.limits`
  (`getFeatureLimit(limits, key)` / `isWithinLimit`) — both fail closed on
  missing keys; enforcement stays server-side.
- **Public:** `GET /api/v1/config/flags` returns global boolean overrides
  (`{ [feature]: "force_off" | "force_on" }`) and
  `GET /api/v1/config/limits` returns global limit overrides
  (`{ [feature]: number | null }`), both 60 s cache. Clients may apply a
  `force_off` (or a downward limit clamp, `min` with the cached value) as
  an immediate kill switch, but must **not** apply `force_on` or raise a
  limit from these maps — only the authenticated snapshot resolves those
  authoritatively.

## Operator surface

Admin console → Feature Flags screen; API under `/admin`:

- `GET /admin/feature-flags` — toggle registry + global state + override
  counts (support role)
- `PUT/DELETE /admin/feature-flags/:feature/global` — set/clear the
  global toggle override (admin role; `reason` required for `force_off`)
- `GET /admin/feature-flags/:feature/users` — paginated override list
- `GET|PUT|DELETE /admin/users/:id/feature-flags[/:feature]` — inspect and
  manage per-user toggle overrides (mutations: admin role)

The numeric limits have the twin surface under `/admin/feature-limits`:

- `GET /admin/feature-limits` — limit registry + global value + override
  counts (support role)
- `PUT/DELETE /admin/feature-limits/:feature/global` — set/clear the
  global limit value (admin role; `reason` always required)
- `GET|PUT|DELETE /admin/users/:id/feature-limits[/:feature]` — inspect
  and manage per-user limit overrides (mutations: admin role)

All mutations flow through the standard admin audit interceptor.
