# fix-frontend-dirty — gate live routing to dirty edits

## Problem

`usePlannerRouting` was mounted unconditionally in the trip planner page. Opening
a saved or imported trip (which already has `activeDayRouteGeometry`) caused a
Valhalla request ~300 ms after mount, overwriting the stored geometry with a
fresh route before the rider touched anything. This meant (1) curated routes
visibly changed on open, (2) clicking Save immediately after opening would
persist the unintended reroute, and (3) if Valhalla was down the page showed a
routing error despite valid stored geometry.

## Fix

Three-layer gate keyed on a `routeDirty` boolean:

### 1. Store (`apps/companion/src/stores/trip.ts`)

- Added `routeDirty: boolean` to `TripState` (docs: "true only after the rider
  makes a change that requires a fresh route").
- Added `markRouteDirty: () => void` action.
- `routeDirty` starts `false` and is reset to `false` in `setActiveTrip`.
- The following mutations set `routeDirty: true` in the same `set()` call:
  `placeWaypoint`, `moveWaypoint` (only when the drag actually moved the point),
  `removeWaypointById`, `reorderWaypoints`, `setWaypointType`,
  `appendPlannerWaypoint`.
- `resetForTest` also resets to `false`.

### 2. Hook (`apps/companion/src/hooks/usePlannerRouting.ts`)

- Added `enabled = true` as an optional 5th parameter.
- When `enabled` is `false`, the effect immediately calls `setRouting(false)` and
  returns, suppressing the API call and the 300 ms debounce timer. `enabled` is
  included in the dependency array.

### 3. Page (`apps/companion/src/app/(dashboard)/trips/planner/page.tsx`)

- Added `routeDirty` and `markRouteDirty` selectors from `useTripStore`.
- Computed `liveRouteEnabled = routeDirty || !activeDayRouteGeometry`.
  - `true` when no stored geometry yet → new trip → route immediately.
  - `true` once the rider makes any mutation → re-route on change.
  - `false` when geometry exists and nothing has changed → suppress routing.
- Removed duplicate `activeDayRouteGeometry` declaration (was defined twice).
- Added wrapped handlers `handleAvoidHighwaysChange`, `handleAvoidTollsChange`,
  `handleAvoidUnpavedChange` that call both the setter and `markRouteDirty()`.
  These are used only in the JSX checkboxes; the three `setAvoid*` calls inside
  load/hydration effects are left untouched to avoid marking dirty on mount.

## Tests

- `trip.test.ts`: 9 new cases in `describe("useTripStore routeDirty flag", …)` —
  initial false, each mutation sets true, setActiveTrip resets, no-op moveWaypoint
  does not set dirty, markRouteDirty exposed.
- `usePlannerRouting.test.ts`: 3 new cases — `enabled=false` never calls the API
  and returns `routing: false`; `enabled=true` keeps existing debounce behaviour.
- `page.test.tsx`: `routeDirty`/`markRouteDirty` added to mock type; 4 new cases
  covering liveRouteEnabled gate (no geometry → enabled, has geometry + not dirty
  → disabled, dirty → enabled, avoid-option checkboxes call markRouteDirty).

## Validation

- `pnpm --filter @tarmoto/shared build` → clean
- `vitest run` (companion): **1052 / 1052 tests pass** (113 files)
- ESLint: 0 errors, 7 warnings (all pre-existing; none introduced by this change)
- TypeScript strict-mode errors in the companion build are pre-existing
  (unresolved imports in unrelated modules); no new errors introduced
