# Feature Flags & Tier Entitlements

Tarmoto gates premium features with a tier-aware feature-flag system,
implemented the same way as its sibling projects (nexcue, tabletap): the
flag vocabulary is **code-defined**, the database stores **only override
state**, and every gated endpoint re-resolves **live** so an operator kill
switch takes effect immediately.

## Registry (source of truth)

`packages/shared/src/feature-flags.ts` — `FEATURE_KEYS` +
`FEATURE_DEFINITIONS`. Each definition carries a description, a baseline
`default`, and the subscription tiers granted the feature (see the product
spec §Monetization). Operators cannot invent keys at runtime; adding a
flag is a code change:

1. add the key to `FEATURE_KEYS` + `FEATURE_DEFINITIONS`,
2. add the matching field to `FeatureSnapshotDto`
   (`apps/backend/src/modules/features/dto/feature-snapshot.dto.ts`) — the
   compile-time shape guard fails the build if you forget,
3. regenerate OpenAPI (`pnpm --filter @tarmoto/openapi generate`).

The registry mirrors the marketing pricing card one flag per line item.
Tier naming (decided 2026-07, swapping the original marketing copy):
**Pro is the €29.99 mid tier, Premium the €49.99 top tier.**

| Key                       | Tiers              | Gated surface                                                                                                       |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `basic_navigation`        | free, pro, premium | — (client gating only, for now)                                                                                     |
| `road_quality_overlay`    | free, pro, premium | — (client gating only, for now)                                                                                     |
| `hazard_alerts`           | free, pro, premium | — (client gating only, for now)                                                                                     |
| `unlimited_trip_planning` | pro, premium       | — (limit enforcement is a follow-up)                                                                                |
| `full_road_quality_zoom`  | pro, premium       | — (client gating only, for now)                                                                                     |
| `offline_maps`            | pro, premium       | — (feature not built yet)                                                                                           |
| `gpx_export`              | pro, premium       | `GET /rides/export.gpx`                                                                                             |
| `commuter_mode`           | pro, premium       | the whole `/commute/*` controller                                                                                   |
| `group_rides`             | premium            | `/group-rides` create/join/detail + the socket rooms; `leave`/`end` stay open so a revoked rider can still clean up |
| `priority_hazard_alerts`  | premium            | — (feature not built yet)                                                                                           |
| `advanced_analytics`      | premium            | — (feature not built yet)                                                                                           |

(`commuter_mode` is not on the pricing card but is a Pro-tier feature per
the product spec §Monetization.)

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

Every flag whose feature is already live and open to everyone
(`gpx_export`, `commuter_mode`, `group_rides`, `unlimited_trip_planning`,
`full_road_quality_zoom`) was seeded `force_on` by migrations 1795/1796 so
introducing tier gating changed nothing for current users. Clear the
overrides (`DELETE /admin/feature-flags/:feature/global`) when tier
enforcement should go live. Flags for not-yet-built features
(`offline_maps`, `priority_hazard_alerts`, `advanced_analytics`) carry no
override and resolve purely by tier from day one.

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
  `/auth/register`, `/auth/refresh`) carries `subscription_tier` and a
  resolved `features` snapshot. Clients gate UI from `user.features`
  (`isFeatureEnabled(features, key)` fails closed on missing keys);
  enforcement stays server-side.
- **Public:** `GET /api/v1/config/flags` returns only the global
  overrides (`{ [feature]: "force_off" | "force_on" }`, 60 s cache).
  Clients may apply `force_off` as an immediate kill switch on top of a
  cached snapshot but must **not** apply `force_on` from this map — only
  the authenticated snapshot resolves it authoritatively.

## Operator surface

Admin console → Feature Flags screen; API under `/admin`:

- `GET /admin/feature-flags` — registry + global state + override counts
  (support role)
- `PUT/DELETE /admin/feature-flags/:feature/global` — set/clear the
  global override (admin role; `reason` required for `force_off`)
- `GET /admin/feature-flags/:feature/users` — paginated override list
- `GET|PUT|DELETE /admin/users/:id/feature-flags[/:feature]` — inspect and
  manage per-user overrides (mutations: admin role)

All mutations flow through the standard admin audit interceptor.
