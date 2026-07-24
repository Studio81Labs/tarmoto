# Companion Entitlement Foundation — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorm)
**Scope:** Sub-project 1 of the "client consumption of entitlements" epic.

## Background

The backend already resolves and **serves** per-user entitlements to clients:

- `GET /users/me` (`UserResponseDto`) carries `subscription_tier`, a resolved
  `features` snapshot (toggle map), and a resolved `limits` snapshot (numeric
  map; `null` = unlimited). Login/register responses embed the same via
  `FeatureResolver.resolveEntitlementsForLoadedUser`.
- `packages/shared/src/feature-flags.ts` is the single-source catalog
  (`FEATURE_DEFINITIONS`) mapping every flag/limit to its per-tier values, plus
  pure resolver helpers (`isFeatureEnabled`, `getFeatureLimit`, `resolveLimit`).

The gap is entirely client-side: **the companion drops these entitlements on
the floor.** Its auth store does not carry `tier`; its `User` type omits
`features`/`limits`; it reads tier from the billing snapshot
(`GET /account/subscription`) instead. There is no `useFeature` hook, no
`<FeatureGate>`, and no upgrade-nudge component. Nothing gates UI on the
resolved map, and no limit usage ("1 of 1 trips") is shown before the server
403s.

This sub-project builds the companion-side foundation and proves it end-to-end
on one server-enforced limit (`max_active_trips`). Gating the remaining
features and the mobile client are separate sub-projects.

### Decisions captured during brainstorming

1. **Gate UX = proactive block + upgrade nudge.** Disable the action when at a
   limit / lacking a flag, show usage and an inline upgrade CTA _before_ any
   click. The server 403 stays as a safety net that surfaces the same prompt.
2. **State source = react-query `GET /users/me` as the single source of
   truth.** `useFeature`/`useLimit` derive from the cached query via the shared
   pure resolvers. Refresh via `refetchOnWindowFocus` plus explicit invalidation
   on return from the subscription page (after a Stripe checkout/portal round
   trip).
3. **Upgrade target tier is derived from the shared catalog**
   (`FEATURE_DEFINITIONS`), not hardcoded, so copy stays correct as tier
   membership evolves.
4. **Proof surface is `max_active_trips` only.** All other feature gating is
   deferred to Sub-project 2.

## Server contract this design relies on (already shipped, do not change)

- `max_active_trips` counts **owner-held** trips whose status is in
  `{draft, planned, active}` (NOT `completed`) —
  `apps/backend/src/modules/trips/trips.service.ts:84-85` (`OPEN_TRIP_STATUSES`).
  The client counter/gate MUST replicate exactly this rule.
- The limit is currently seeded `NULL` (unlimited) for every tier in launch
  mode (`migrations/1813000000000-AddLimitEntitlements.ts`). The gate therefore
  **ships dark** in production and only activates when the seed flips at
  monetization go-live. This is intentional and consistent with the rest of the
  entitlements epic.
- On a limit breach the mint paths throw `featureLimitExceeded(key, limit,
current)`. The client safety net keys off this error shape (see §5).

## Components

### 1. Entitlement hooks — `apps/companion/src/hooks/`

- **`useEntitlements()`** owns the `$api` `GET /users/me` query (openapi-
  react-query dedupes by query key, so multiple consumers share a single
  fetch). Returns `{ tier, features, limits, isLoading }`. Query options set
  `refetchOnWindowFocus: true`.
  - Reconcile with any existing `/users/me` fetch: use the same query key the
    generated client produces so there is one cache entry, not two.
- **`useFeature(key: ToggleFeatureKey): { enabled: boolean; isLoading: boolean }`**
  derives from the `features` snapshot (index the resolved map; do not re-resolve
  from tier — the server already applied global overrides). While `isLoading`,
  callers must treat `enabled` as _unknown_ and render neutrally (skeleton or
  nothing) rather than flashing the locked state.
- **`useLimit(key: LimitFeatureKey): { limit: number | null; isLoading: boolean }`**
  returns the resolved limit (`null` = unlimited).

These hooks are the only place the raw snapshot is read; UI code consumes the
hooks, never `/users/me` directly.

### 2. `<UpgradePrompt>` — `apps/companion/src/components/entitlements/`

Presentational. Inputs: the required capability (a feature key or a limit key)
and a layout variant. Responsibilities:

- Derive the **minimal sufficient tier** from `FEATURE_DEFINITIONS`: the
  lowest tier that grants the toggle, or (for a limit) the lowest tier whose
  limit value is higher/unlimited than the current tier's. Render
  "Upgrade to {Pro|Premium} →".
- Link to the existing `/settings/subscription` page.
- Two layouts: **inline** (compact, sits under a disabled action) and
  **modal** (used by the 403 safety net).

No data fetching, no tier reads of its own — the caller passes what it needs so
the component is trivially testable.

### 3. `<FeatureGate feature="...">` — toggle gating

Wraps children for tier-locked toggles. Renders:

- children when `useFeature(key).enabled`,
- a locked state + inline `<UpgradePrompt>` when not enabled,
- nothing / a skeleton while `isLoading` (no locked-state flash).

Per the "proactive block" decision, locked features are shown in a locked
state (discoverable), never fully hidden. `<FeatureGate>` is delivered as part
of the foundation but is only _wired to real features_ in Sub-project 2; this
sub-project ships it with tests and, at most, uses it where it naturally falls
out of the `max_active_trips` work.

### 4. Proof surface — `max_active_trips` on the trips page

`apps/companion/src/app/(dashboard)/trips/page.tsx` and its create/import/plan
entry points.

- Compute `openTripCount` from the existing user-trips list: count trips where
  the current user is **owner** and status ∈ `{draft, planned, active}`.
  Centralize this in a small pure helper (e.g. `countOpenOwnedTrips`) so the
  rule lives in one place and is unit-tested against the server constant.
- Read `useLimit('max_active_trips')`. When `limit !== null &&
openTripCount >= limit`:
  - disable the New trip / Import / Plan actions,
  - show `"{used} of {limit} trips"` on the Free plan,
  - render the inline `<UpgradePrompt>`.
- When `limit === null` (unlimited — today's launch-mode default) the surface
  behaves exactly as it does now (gate inert).

### 5. 403 safety net

A shared helper `isFeatureLimitError(error)` recognizes the backend's
`featureLimitExceeded` response from an openapi-client error. The
create/import/generate mutation `onError` handlers call it and, on a match,
open the `<UpgradePrompt>` modal instead of a generic toast. This covers races
(two tabs, stale count) and any mint path not pre-gated in the UI.

### 6. Refresh after upgrade

The `/settings/subscription` page invalidates the `/users/me` query after a
checkout/portal return so the new tier's entitlements apply immediately.
`refetchOnWindowFocus` handles the general staleness case.

## Data flow

```
GET /users/me (react-query cache)
  └─ useEntitlements() → { tier, features, limits }
       ├─ useFeature(key)  → { enabled, isLoading }      → <FeatureGate>, <UpgradePrompt>
       └─ useLimit(key)    → { limit, isLoading }         → trips page counter + gate
                                                              │
trips list (useUserTrips) ── countOpenOwnedTrips ── openTripCount
                                                              │
                                    atLimit = limit !== null && used >= limit
                                                              │
                            disable actions + counter + inline <UpgradePrompt>
                                                              │
mint mutation 403 (featureLimitExceeded) ── isFeatureLimitError ── modal <UpgradePrompt>
```

## Testing

- **Hook unit tests** (jsdom + react-query wrapper): tier→feature/limit
  resolution for each tier; `isLoading` semantics; `null` = unlimited.
- **`countOpenOwnedTrips`** unit test: asserts the {draft,planned,active} +
  owner-only rule, guarding against drift from the server constant.
- **`<UpgradePrompt>` / `<FeatureGate>`** component tests: correct derived
  target tier + subscription link; children-vs-locked-vs-loading branches.
- **Trips-page tests**: at-limit disables actions + shows the counter;
  under-limit (and unlimited) render normally; a mint 403 opens the modal.
- Follow existing companion test idioms (react-aria in jsdom; run `tsc` after
  editing tests — companion CI typechecks test files).

## Scope boundaries (YAGNI)

- **In scope:** the three hooks, `<UpgradePrompt>`, `<FeatureGate>`,
  `isFeatureLimitError`, `countOpenOwnedTrips`, the `max_active_trips` proof on
  the trips page, refresh wiring, and the tests above.
- **Out of scope:** gating any other feature or limit (Sub-project 2); any
  billing/checkout changes (already shipped); the mobile client (Sub-project 3);
  removing the launch-mode unlimited seed (a go-live task).

## Risks / notes

- **Client/server count divergence:** if the client's open-trip rule drifts
  from `OPEN_TRIP_STATUSES`, the pre-gate and the 403 disagree. Mitigated by the
  single pure helper + its unit test; the 403 safety net makes any divergence
  fail safe (user still blocked correctly server-side).
- **Loading flash:** never render the locked/at-limit state while entitlements
  are loading — treat unknown as allowed-pending and show neutral UI.
- **Ships dark:** with launch-mode unlimited seeds, none of this is visible in
  prod until the seed flips. Verification must therefore drive the gate with a
  non-null limit (test fixtures / a locally overridden limit), not rely on prod
  data.
