# Numeric Feature Limits (Tier Entitlements v2) — Design

- **Date:** 2026-07-17
- **Status:** Approved (design); pending implementation plan
- **Builds on:** the tier-aware entitlement registry in `packages/shared/src/feature-flags.ts` (11 boolean flags, code-defined; migration `1795-AddTierFeatureEntitlements` replaced the legacy free-form `feature_flags` store), the admin flags surface (`admin-flags` module + `FeatureFlagsScreen`/`UsersScreen`), and `FeatureResolver`/`FeatureGuard`. The 2026-06-28 feature-flags design listed "typed/non-boolean values" as an explicit future phase — this is that phase.
- **Scope:** universal numeric ("limit") entitlements alongside boolean ("toggle") flags — registry, resolution, storage, wire contract, admin surface — plus the first enforced limit, `max_active_trips`.

## 1. Background & motivation

The entitlement registry is boolean-only, but the product spec (§6 Monetization) and the marketing pricing card sell numeric entitlements: "1 active trip plan" (free) and "collaborative trips (up to 5 riders)" (pro). Today those numbers exist **only as copy** — in `PLAN_CATALOG`, `Pricing.tsx`, and flag descriptions. There is no constant, no counter, and no enforcement anywhere; `unlimited_trip_planning` is resolved into every snapshot but never checked.

Separately, an enforcement audit found only 3 of 11 flags are enforced (`gpx_export`, `commuter_mode`, `group_rides`) and **no client reads any flag**. Narrowing that gap is a broader workstream; this design removes its structural blocker — numbers cannot currently be expressed at all.

## 2. Decisions (user-confirmed)

1. **Universal mechanism**, not one-off constants: any entitlement key can be numeric; which keys exist is registry data.
2. **Full override parity with toggles**: limits get per-user overrides _and_ global overrides, admin-managed.
3. **Curated flag list arrives later** as a separate product input. This design does not add/remove/rename any toggle; `unlimited_trip_planning` stays untouched (nothing reads it) until that list lands.
4. **`max_active_trips` cap counts open owned trips**: status `draft`/`planned`/`active`, owner only — joining someone else's trip never counts. Matches the pro counter-line "unlimited trip _planning_"; a literal `status='active'` reading would leave unlimited free drafts and no upgrade motivation.
5. **v1 enforces `max_active_trips`** as the first consumer, shipped dark via a launch-mode global override (see §3.6) exactly as the boolean flags shipped with seeded `force_on`.

## 3. Design

Architecture choice: **unified registry, kind-split wire**. One registry/resolution/override/admin model (universal), but resolved values ship as two typed maps — the existing `features` boolean map (byte-identical) plus a new additive `limits` map. Rejected: a single `Record<key, boolean | number | null>` wire map (breaks `FeatureSnapshotDto`, forces type discrimination on every consumer, `oneOf` churn in generated clients) and a fully parallel limit subsystem (two registries, two admin models — the opposite of universal).

### 3.1 Registry (`packages/shared/src/feature-flags.ts`)

`FeatureDefinition` becomes a discriminated union on `kind`:

- `kind: "toggle"` — exactly today's shape (`description`, `default: boolean`, `tiers: readonly SubscriptionTier[]` allowlist). All 11 current flags unchanged.
- `kind: "limit"` — `description`, `default: number | null` (applied when the tier is unknown/invalid), `tiers: Readonly<Record<SubscriptionTier, number | null>>` — an explicit full per-tier map (no allowlist ambiguity for numbers).

**`null` means unlimited at every layer** (registry, overrides, wire, checks).

Derived key types via conditional types over the definitions: `ToggleFeatureKey`, `LimitFeatureKey` (union = `FeatureKey`). Existing exported types keep their meaning: `FeatureSnapshot = Record<ToggleFeatureKey, boolean>` (same concrete shape as today since no current key is a limit); new `LimitSnapshot = Record<LimitFeatureKey, number | null>`.

First limit entry:

```ts
max_active_trips: {
  kind: "limit",
  description: "Maximum open (draft/planned/active) trips a user may own.",
  default: 1,
  tiers: { free: 1, pro: null, premium: null },
}
```

New registry invariant (spec-tested): limit values are monotone non-decreasing across the tier ladder (`free ≤ pro ≤ premium`, `null` = ∞) — the numeric analogue of the existing "no downgrade holes" toggle test.

### 3.2 Resolution

New pure `resolveLimit(key, tier, userOverride, globalOverride): number | null` beside `resolveFeature`:

1. tier value from the registry (or `default` for unknown tier)
2. per-user override value (`number | null`) — support can raise _or_ restrict one user
3. global override value (`number | null`) — **replaces the tier layer absolutely**; where a per-user override also exists, the **more restrictive** of the two wins (`min`, with `null` = ∞)

Rule 3 is the exact numeric analogue of the boolean pair: `force_off` ≙ a low global value (`min` makes it absolute), `force_on` ≙ a global raise that every explicit per-user restriction still survives. One semantic covers all three operational cases: launch mode (`null` = unlimited for everyone — while a support restriction like "this spammer gets 0 trips" keeps biting), emergency clamp (a low number beats even support-raised users), promo raise.

Client-side rule (documented on the type, parallel to the existing `force_on` rule): clients may only apply a global limit **downward** (`effective = min(snapshot, global)` with `null` = ∞); raising is resolved only by the authenticated snapshot.

Helpers:

- `buildLimitSnapshot(tier, overrides, globalOverrides): LimitSnapshot` — unknown keys in override maps ignored (stale rows never widen the set).
- `getFeatureLimit(limits, key, fallback = 0): number | null` — `Object.hasOwn`-guarded safe read; a missing key returns the most-restrictive fallback, never unlimited.
- `isWithinLimit(limit: number | null, currentCount: number): boolean` — true when there is room for one more (`limit === null || currentCount < limit`); `isWithinLimit(1, 1)` is false (at cap).

### 3.3 Storage

Two new tables mirroring the boolean pair (service layer is universal; tables stay single-purpose — no "enabled means nothing for limits" columns):

- **`user_limits`**: `id uuid pk`, `user_id uuid` (FK users, CASCADE), `feature varchar(64)`, `value integer NULL`, timestamps; unique `(user_id, feature)`, index on `feature`. Row presence = override; `value NULL` = unlimited.
- **`limit_states`**: `id uuid pk`, `feature varchar(64)` unique, `value integer NULL`, `reason varchar(500) NULL`, `updated_by uuid NULL`, timestamps.

One migration creates both and **seeds launch mode**: `limit_states('max_active_trips', NULL, 'launch mode')`. Monetization/billing is not live; without this seed, `free = 1` would instantly cap every existing user (all are free-tier and many own multiple trips).

`FeatureResolver` extends to load both limit layers and expose `resolveLimitsForUser` / combined resolution alongside the existing snapshot path (still 5 indexed reads total per resolution, no caching change).

### 3.4 Wire contract (additive only)

- `/users/me` and auth responses (`login`/`register`/`refresh`): new `limits: LimitSnapshotDto` beside the untouched `features: FeatureSnapshotDto`, with the same compile-time shape-guard pattern.
- `GET /api/v1/config/flags`: response gains `limits: Record<string, number | null>` (active global limit overrides) beside the existing states map, same 60 s cache semantics, for the client downward-clamp fast path.
- OpenAPI regen + generated-client refresh in companion/mobile/admin. All changes additive; no existing field changes shape.

### 3.5 Admin surface

Limit twins inside the existing `admin-flags` module (same guards, roles, audit interceptor pattern):

- `GET /admin/feature-limits` (support+) — registry definitions + per-tier values + current global override
- `PUT /admin/feature-limits/:feature/global` (admin+) — body `{ value: number | null, reason: string }`; reason always required (any global limit change is user-visible)
- `DELETE /admin/feature-limits/:feature/global` (admin+, 204)
- `GET /admin/users/:userId/feature-limits` / `PUT …/:feature` (body `{ value: number | null }`) / `DELETE …/:feature` (support+ read, admin+ write — matching the toggle endpoints' role split)

Validation: `:feature` must be a registry `LimitFeatureKey`; `value` integer ≥ 0 or `null`.

UI: `FeatureFlagsScreen` gains a **Limits** section (per-tier values, global override editor with an "unlimited" affordance, reason dialog); the `UsersScreen` per-user override panel gains limit rows (resolved value + override state + numeric/unlimited editor).

### 3.6 First enforcement: `max_active_trips`

Service-level check in `TripsService` (counts are not decorator-expressible; `FeatureGuard` unchanged) at the four paths that mint an open owned trip:

1. `POST /trips` (create)
2. `POST /trips/import`
3. `POST /trips/:tripId/duplicate`
4. `PATCH /trips/:tripId` transitioning status from `completed` back to an open status (reopen)

Check: `isWithinLimit(resolveLimit('max_active_trips', …), count(trips where owner = user AND status IN (draft, planned, active)))` — the count is taken _before_ minting, so `current < limit` permits; on violation throw `403` whose body carries a machine-readable payload via the backend's standard error envelope: `code: 'FEATURE_LIMIT_EXCEEDED'`, `feature`, `limit`, `current` — so clients can later render upgrade prompts without string-matching.

Create-time only, never retroactive: users over a future cap keep every existing trip and can complete/delete freely; they just cannot mint a new open trip until under the cap. With the launch-mode seed in place, behavior at deploy time is unchanged for everyone.

### 3.7 Testing

- **Shared**: registry invariants (kind partition, limit monotonicity), `resolveLimit` precedence table (tier value / unknown tier / user raise + restrict / global raise survived by an explicit user restriction / global clamp beating a support-raised user / `null` at each layer), `buildLimitSnapshot` (every key, stale-key immunity), `getFeatureLimit` + `isWithinLimit` edge cases (missing key, prototype-collision keys, `null`).
- **Backend**: `FeatureResolver` limit layers; admin-limits service/controller (validation, roles, reason requirement, audit); trips enforcement — each of the 4 paths at-cap vs under-cap, launch-mode `null` passthrough, error payload shape; `/me` + auth responses carry `limits`.
- **Admin UI**: Limits section rendering + mutations; user-override limit rows.
- **Contract**: OpenAPI regen committed; generated clients compile in all consumers.

## 4. Out of scope (follow-ups)

- The **curated flag/limit list** (product input) — lands later as registry data edits, including `unlimited_trip_planning`'s fate and the pro `max_trip_collaborators` (5) cap.
- Client-side gating & upgrade UX in mobile/companion (the broader flag-narrowing workstream; the `FEATURE_LIMIT_EXCEEDED` payload is designed for it).
- Enforcement of the remaining un-enforced toggles.
- Removing the launch-mode override (a monetization-go-live operational step, alongside the boolean `force_on` cleanups and Stripe wiring).
