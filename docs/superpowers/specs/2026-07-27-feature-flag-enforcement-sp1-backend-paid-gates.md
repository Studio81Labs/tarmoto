# Feature-Flag Enforcement — SP1: Backend Paid-Entitlement Gates

**Epic:** "All feature flags work" — wire enforcement + client gating for every flag whose feature exists (A+B+C+D from the gap audit; E deferred as not-built). Catalog: `docs/feature-flags.md`. This is **sub-project 1 of 4** — backend-only paid-entitlement gates. Sequenced first because it is small, server-authoritative, and unblocks the SP2 mobile hide/upsell.

## Goal

Enforce three paid entitlements server-side that currently resolve into the `/users/me` snapshot but gate nothing: `advanced_ride_stats` (Pro), `max_group_ride_members` (limit), and `collaborative_trips` (Pro). After this, a non-entitled rider cannot obtain the gated data/capability from the API regardless of client.

## Scope decisions

- **Backend only.** Client hide/upsell for these (and the other surfaces) is SP2. Server enforcement must stand alone — a non-entitled client that ignores the UI still gets blocked.
- **Ships dark.** All three are seeded/tier-resolved consistently with the existing launch posture (see §Dark below). No behaviour change for current (gifted/seeded) riders.
- **No OpenAPI contract break.** `advanced_ride_stats` gating nulls existing nullable fields (they are already `| null`); no field is added or removed.
- **Reuse existing primitives:** `FeatureResolver` (already injected in `RidesService`), `isFeatureEnabled`/`getFeatureLimit`/`resolveLimit` from `@tarmoto/shared`, the `FEATURE_LIMIT_EXCEEDED` error (`feature-limit.error.ts`), and `@RequireFeature`/`FeatureGuard`.

## Feature 1 — `advanced_ride_stats` (Pro toggle): omit advanced fields for non-entitled riders

**Catalog:** "Lean angles, elevation profile, detailed per-ride stats."

The ride detail DTO (`RideResponseDto`, assembled in `RidesService.toRideResponse`) currently returns these **advanced** fields to everyone:

- `max_lean_angle`
- `lean_distribution`
- `elevation_gain`, `elevation_loss`
- per-segment `lean_angle_max` (in `segments[]`)

**Basic** fields stay free for all tiers: `distance_km`, `avg_speed`, `max_speed`, `avg_road_quality`, `avg_curviness`, `curve_count`, `duration_min`, `route_geometry`, `fuel_estimate_l`, per-segment `quality_reading`/`speed_avg`/`speed_max`.

**Approach:** `toRideResponse` is a sync helper called from several places; the entitlement is async. Add a pure helper `stripAdvancedRideStats(dto: RideResponseDto): RideResponseDto` that returns a copy with the advanced fields nulled (segment `lean_angle_max` → `null`). In the **detail** read path (`getDetail` / the single-ride GET), resolve `advanced_ride_stats` for the requesting user and apply the strip when not entitled. The write paths (`start`/`stop`) return the owner's own just-created ride with no stats yet — leave them; the gate lives on the detail/list read.

- Gate the **detail** endpoint (single ride) and any **list** endpoint that includes advanced fields. Verify which list DTOs carry advanced fields; strip there too.
- The viewer's entitlement, not the ride owner's, governs (a Free rider viewing anyone's ride — including a shared ride — sees basic stats only). Resolve via `featureResolver` for `req.user.userId`.

## Feature 2 — `max_group_ride_members` (limit): enforce on join

**Catalog:** Free `0` / Pro `0` / Premium `null`. "Kept as a limit so a paid 'small groups' tier can be added later."

`GroupRidesService.join` inserts a `group_ride_members` row with **no cap check**. Add: before the insert (for a genuinely new member, not a re-join), resolve `max_group_ride_members` for the joining user; if the limit is a finite `N` and the current member count `>= N`, throw the `FEATURE_LIMIT_EXCEEDED` 403 (owner-scoped message: "This group ride is full."). `null` (premium) = unlimited → no check.

- Count members in **one** SQL statement under the same transaction/guard used for the insert (avoid a check-then-insert race — mirror the collaborator-cap advisory-lock pattern in `TripsService` if group-ride join isn't already serialized).
- Today premium = `null` and `group_rides` (premium-only) already gates who can join, so the check is effectively inert — but it wires the seam correctly for a future finite tier, and fails closed if the limit is ever set finite.

## Feature 3 — `collaborative_trips` (Pro toggle): defense-in-depth guard

**Catalog:** "Shared trip planning (size via `max_trip_collaborators`)."

The collaborator **capacity** is already enforced by `max_trip_collaborators` (Free 0). Add `@RequireFeature('collaborative_trips')` to the collaborator-mutation endpoints (invite create, group-link/personal-code join is trickier — scope to the **invite-create** + collaborator-management endpoints that a non-owner-collaboration would use) as defense-in-depth: a Pro/Premium-only toggle guarding the whole shared-planning surface, independent of the numeric cap.

- Confirm the exact endpoints in `TripsController` / `TripSharesController` and gate the ones that _create_ collaboration (not read). A Free rider (toggle off) gets a feature-guard 403 (no `code`, per the `@RequireFeature` contract).
- Do **not** gate trip creation itself (that's `trip_planning`, a free flag) — only the collaboration surface.

## Dark / launch posture

- **Decision: ship dark via a new `force_on` seed** (consistent with the 7 existing launch seeds). `advanced_ride_stats` and `collaborative_trips` are not currently seeded, so once their gates land they would resolve by tier and gate a genuinely-Free rider **immediately**. To match the established dark-ship posture — never regress an existing rider mid-flight; flip all monetization together at go-live — add a migration seeding `feature_states force_on` for **`advanced_ride_stats`** and **`collaborative_trips`** (mirroring migration 1795's `gpx_export`/`commuter_mode`/`group_rides` rows, same reason string). The enforcement CODE is fully wired and tested; the seed keeps it inert until an operator clears it at go-live (which then also clears the other 7). Update `docs/feature-flags.md` §6.2 to move the seed count 7 → 9 and add these two to the enforced-entitlements list.
- `max_group_ride_members` is unseeded but inert (premium = `null` = unlimited); no seed needed.

## Testing

- `advanced_ride_stats`: entitled viewer → advanced fields present; non-entitled viewer → advanced fields null, basic fields intact; a shared ride viewed by a Free rider → basic only. Unit test the pure `stripAdvancedRideStats`; e2e the detail endpoint both ways.
- `max_group_ride_members`: at cap → 403 `FEATURE_LIMIT_EXCEEDED`; under cap → joins; re-join by existing member → no-op (not counted); premium/null → unlimited.
- `collaborative_trips`: toggle off → 403 on invite-create; on → allowed; trip creation unaffected.
- No OpenAPI diff beyond `advanced_ride_stats` field descriptions (nullable already); run `pnpm openapi:gen` and confirm no breaking change.

## Out of scope (later sub-projects)

- Client hide/upsell for these + commute/group/trips/offline/full-zoom (SP2).
- `offline_maps` / `max_offline_regions` (mobile-client-only — SP2).
- `road_quality_full_zoom` toggle (upsell-only; capability already gated by `road_quality_max_zoom` — SP2 client messaging).
- System switches (SP3), Free-tier kill-switches (SP4), not-built features (E, deferred).
