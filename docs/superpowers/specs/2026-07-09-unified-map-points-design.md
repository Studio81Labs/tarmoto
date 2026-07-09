# Unified map points (pins · popovers · toggles) across the three maps

Status: approved design, phased delivery.

## Goal

The companion has three MapLibre surfaces — the road **explorer** (`QualityMap`),
the trip **planner/edit** and trip **preview** (both `TripPlannerMap`) — that all
wrap `MapCanvas`. Today the "ambient point" layers (POIs, hazards, closures,
passes) diverge: hazards are explorer-only, closures/passes are planner-only
markers (a side-panel list on the explorer), the hazard popover is a raw
MapLibre HTML string while conditions/POIs are React, and the toggles differ
(explorer: separate Hazards/Closures/Passes; planner: one combined "Conditions",
no Hazards).

Unify so that **every point on every map** uses the same pins, the same popover,
and the same toggle set.

## Decisions (confirmed)

1. **Toggle set:** `Hazards` + `Conditions` on all three maps. "Conditions"
   toggles closures **and** passes together (the planner's current model). This
   replaces the explorer's separate Closures/Passes pills and adds Hazards to
   the planner/preview.
2. **Panels stay.** The right-panel conditions list (planner/preview CONDITIONS
   tab; explorer side panel) is kept. What is added everywhere: clicking a
   condition in the list **focuses/zooms the map and opens its popover**
   (`openConditionPopover`, already on `TripPlannerMap`; added to the explorer).
3. **Delivery:** three phased PRs.

## Target architecture

- **One popover** — `MapPointPopover` (React), a discriminated union over
  `poi | hazard | closure | pass`. Shared card shell (fixed position, close on
  the title row) + a per-kind body. Conditional action block:
  - POI + editable → add as via / set start / finish / stop / remove
  - closure|pass + editable + affectsRoute → "Reroute around it"
  - POI (any mode) → "View on Google Maps"
  - hazard, and view-only conditions → info only
    This folds in today's `PoiPopover`, the planner's inline condition popover, and
    replaces the raw-HTML hazard popup.
- **Shared pin/marker modules** (mirroring `PoiPinLayer`):
  - `PoiPinLayer` (exists) — converge the planner's duplicate inline POI setup.
  - `HazardPinLayer` — extract the explorer's clustered emoji-circle hazard
    layers.
  - `ConditionMarkerLayer` — extract the planner's closure line + closure/pass
    rotated-square "diamond" markers.
- **All layers on all three maps**, fed by viewport-bbox fetches:
  - closures/passes: `useClosures`/`usePasses` already accept a `bbox` — wire
    the viewport bbox on the explorer; keep the route-check on planner/preview
    for the `affectsRoute` signal (and add a viewport fetch so markers cover the
    whole view, not only the route).
  - hazards: reuse `hazardsApi.findNearby(center, radius)` on viewport move for
    the planner/preview (same as the explorer).
- **One toggle set + shared state.** `Hazards` + `Conditions` buttons on all
  three, backed by shared state (extend the zustand map store or a shared hook)
  instead of the current split (store vs component-local `conditionsVisible`).

## Phasing

- **PR 1 — popover unification.** Build `MapPointPopover`; replace the raw hazard
  HTML popup (explorer) and the planner's inline condition popover with it, and
  fold in the POI branch. No new layers — each map keeps the points it already
  shows, just through one popover.
- **PR 2 — shared layer modules.** Extract `HazardPinLayer` +
  `ConditionMarkerLayer`; converge the planner POI onto `PoiPinLayer`. No
  behaviour change.
- **PR 3 — all-on-all-3 + unified toggles + list focus.** Explorer gains
  condition markers (bbox fetch); planner/preview gain hazard pins (viewport
  fetch). Replace toggles with `Hazards` + `Conditions` everywhere; wire
  list-click → focus/zoom + popover on the explorer.

## Risks / notes

- `TripPlannerMap` is large and heavily tested (55 map tests) — the popover
  swap and layer extraction must preserve button text/behaviour so those tests
  pass unchanged.
- `affectsRoute` / reroute only apply where a route exists (planner/preview); the
  explorer's condition popover is info-only.
- Hazards have no bbox endpoint — the center+radius `findNearby` is reused as-is.
