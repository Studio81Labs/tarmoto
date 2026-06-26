# E2E fix: planner specs reworked for manual live-route flow

## Background

Phase-1 of `feat/route-planner-live-routing` replaced the old "Generate
itinerary" UI (button + option cards + old "Save" button) with a manual
flow: place start/end via right-click context menu → live road-snapped route
→ "Save route" button. Three spec files (`trip-planner.spec.ts`,
`trip-planner-closures.spec.ts`, `trip-planner-extras.spec.ts`) still drove
the removed UI, causing `.click()` failures on every test, 3× retries, and
20-minute CI job timeouts.

## Mock endpoints added (`e2e/mock-backend/server.ts`)

| Endpoint                          | Purpose                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__test__/seed-trip`        | Creates a trip in mock state with optional day-1 route geometry and waypoints. Returns `TripDetailDto` shape. Used by tests to bypass the planner UI entirely.          |
| `POST /api/v1/routing/route`      | Returns deterministic interpolated GeoJSON LineString geometry spanning the requested waypoints. Distance, duration, quality, and surface mix are synthetic but stable. |
| `PUT /api/v1/trips/:tripId/route` | Accepts waypoints + route result, builds day-1 geometry in `trip.snapshot.days`, returns updated `TripDetailDto`. Mirrors the live-routing save path.                   |

## Fixture change (`e2e/fixtures/index.ts`)

Added `seedTrip(user, opts?)` to `MockApi`. Posts to `/__test__/seed-trip`
with a Bearer token; returns `{ id, title }`. Default geometry is three
points in the Alps region (overlapping the default closure seeding area).

## Per-spec changes

### `trip-planner.spec.ts`

- **Deleted** three generate-flow tests: "three route cards", "Active badge",
  "adjusting trip parameters".
- **Kept** "restoring a planner region surfaces Fun Zones and top roads"
  (unrelated to generate flow — no changes needed).
- **Added** "seeded route renders and Save route persists via the manual
  flow": seeds a trip with day-1 geometry, opens via `?tripId=`, asserts
  heading visible, asserts "Save route" enabled (dirty-gate: existing
  geometry suppresses live routing hook), clicks Save route, asserts
  "Route saved" toast.
- **Replaced** "saving a backend-generated trip" → "saving a route lets us
  reopen the same trip detail": same seed + open + save pattern, then
  navigates to `/trips`, reopens the trip, asserts heading on detail page.

### `trip-planner-closures.spec.ts`

- **Replaced** the `generate itinerary` button click with `seedTrip` +
  `?tripId=` approach. Seeds a closure, seeds a trip with overlapping
  geometry, opens via `?tripId=`. The dirty-gate keeps live routing idle.
  `useClosures.checkRoute` fires once the trip has days; the mock's
  `check-route` endpoint reports every seeded closure as crossing any
  non-empty route. Asserts on "current trip crosses 1 active closure"
  text and on the closure title inside the route-warnings card.

### `trip-planner-extras.spec.ts`

- **T9** (GPX import): kept exactly as-is — no generate flow dependency.
- **T10** (GPX export): replaced generate flow + old URL poll with
  `seedTrip` + `?tripId=`. Waits for heading to confirm load, then:
  1. Clicks Export button to open dropdown.
  2. Asserts "Download GPX" menuitem is visible.
  3. Uses `evaluate(el => el.click())` to fire a trusted click on the
     button — needed because the map's floating "Fit to route" button
     (in a different CSS stacking context from the toolbar's
     `backdrop-blur-sm`) visually covers the dropdown, causing Playwright's
     pointer-events check to fire on the map button instead. The
     `evaluate` path bypasses the hit-test and fires React's event.
  4. Asserts "GPX downloaded" success toast.
- **T14** (Print): replaced generate flow + old Save + URL poll with
  `seedTrip`. Navigates to planner to confirm trip loaded, then opens
  `/trips/:id/print` in a fresh page within the same auth context.

## Key design decision: dirty-gate

`liveRouteEnabled = routeDirty || !activeDayRouteGeometry`. When a trip is
opened via `?tripId=` and it already has day-1 route geometry, the dirty flag
is `false` and `activeDayRouteGeometry` is set, so the live routing hook
stays idle. This means no `POST /api/v1/routing/route` call fires on open,
and the "Save route" button (`canSaveRoute = waypoints.length >= 2 && activeDayRouteGeometry !== null`) is enabled immediately.

## Test results

```
Running 7 tests using 1 worker

  ✓  trip-planner-closures.spec.ts — T13: seeded closure surfaces on route-warnings panel (2.4s)
  ✓  trip-planner-extras.spec.ts  — T9: importing a GPX file adopts it as a trip draft (1.9s)
  ✓  trip-planner-extras.spec.ts  — T10: Export → Download GPX triggers a .gpx download (1.9s)
  ✓  trip-planner-extras.spec.ts  — T14: /trips/:id/print renders the printer-friendly view (2.0s)
  ✓  trip-planner.spec.ts         — restoring a planner region surfaces Fun Zones and top roads (5.4s)
  ✓  trip-planner.spec.ts         — seeded route renders and Save route persists via the manual flow (1.9s)
  ✓  trip-planner.spec.ts         — saving a route lets us reopen the same trip detail (5.9s)

  7 passed (25.3s)
```

Zero retries required. Commit: `e1ce07ac`.

## Known side issue (not fixed here)

The Export dropdown (`z-30`) is in the toolbar's `backdrop-blur-sm` stacking
context, which means its z-index cannot compete with the map's floating
controls (`z-20`) in the main stacking context — the "Fit to route" button
physically overlaps the "Download GPX" menu item on smaller viewports. The
T10 test works around this via `evaluate`, but the production z-index bug
should be fixed separately (render the dropdown via a React portal, or use a
higher z-index token that isn't constrained by the stacking context).
