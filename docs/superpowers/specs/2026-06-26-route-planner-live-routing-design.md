# Route planner — live road-snapped routing (Phase 1, single-day manual)

- **Date:** 2026-06-26
- **Status:** Approved design, pending implementation plan
- **Scope:** Phase 1 of a larger Calimoto-inspired route-planner rework

> **Update (2026-06-26): routing engine = self-hosted Valhalla, not OSRM.**
> After the design was approved we switched the self-hosted engine from OSRM to
> **Valhalla** (both OSS). Reason: Valhalla's per-request **dynamic costing**
> (motorcycle profile, `use_hills`, avoid options, curvy weighting) makes the
> later Calimoto curvy phase a request-time knob instead of a graph rebuild, so
> we avoid re-platforming. The `RoutingProvider` interface already abstracts the
> engine, so only the Docker service (Section 3) and the provider implementation
> (Section 2) change; endpoints, enrichment, and the entire frontend are
> unchanged. The env var is `TARMOTO_VALHALLA_BASE_URL` (Valhalla `/route` JSON
> API, default port 8002). Where this doc says "OSRM" below, read "Valhalla" —
> the binding behaviour (multi-via routing + a road-snapped polyline) is the
> same. The authoritative task-level detail is in the implementation plan.

## Problem

The trip planner does not produce a usable route. Three concrete failures:

1. **Placement is tap-to-drop.** A map tap immediately snaps a waypoint (first
   = start, second = end, then via). There is no way to choose the point type.
2. **The map yanks the view.** After placing a point the map re-fits/re-centers,
   so a rider who zoomed into a street to place the start is thrown back out.
3. **The route is fake.** Until the user presses _Generate_, the drawn line is
   **synthetic** — `trip-planner-builder.buildLegPoints()` produces procedural
   Bézier-ish curves with hash-seeded "quality", **not snapped to roads**. Real
   OSRM routing only runs on _Generate_. So "set start + end" draws lines off
   the roads.

Root files today: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx`,
`apps/companion/src/components/TripPlannerMap.tsx`,
`apps/companion/src/lib/trip-planner-builder.ts` (synthetic geometry),
`apps/companion/src/lib/trip-planner-snap.ts` (road snapping),
`apps/companion/src/stores/trip.ts`,
`apps/backend/src/modules/trips/trip-generator.service.ts` (multi-day OSRM),
`apps/backend/src/modules/commute/providers/osrm.provider.ts` (2-point only).

## Goals (Phase 1)

A **single-day manual planner** that feels real and live:

- Place **start / end / via** via a **context menu** (right-click / long-press),
  not tap-to-drop.
- The route is **always a real, road-snapped line** (OSRM), drawn immediately
  and recomputed **live** as points are placed, dragged, reordered, or deleted.
- Live **distance / time / road-quality** stats that update with the route.
- The map **preserves the rider's pan/zoom** during editing (no auto-yank).
- **Save** persists the route to the existing Trip data model.

## Non-goals (deferred to later phases)

Multi-day auto-itinerary; Calimoto curvy/scenic **auto round-trip** generation; a
curvy/motorcycle OSRM profile; the drag-the-route-line-to-insert-via gesture;
smart fuel-stop auto-insertion; per-vertex elevation API; collaborative waypoint
co-editing. Multi-day is the **next** phase once single-day works.

## Key decisions

1. **Phase 1 = solid single-day manual planner** (multi-day later).
2. **Self-hosted OSRM (Docker)** as the routing engine (car profile for now).
3. **Server-side live routing** — the map calls a backend endpoint that proxies
   OSRM and enriches with PostGIS road quality. (Rejected: client calling OSRM
   directly — exposes the URL, no quality enrichment, CORS; a debounced server
   call is fast enough.)

---

## Section 1 — Interaction model

**Placement via context menu, not tap-to-drop.** Left-click/tap no longer drops
a waypoint (it just closes any open menu/popover). **Right-click (desktop) /
long-press (touch)** opens a small menu at that location with **state-aware**
options:

| Current state | Menu options                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------- |
| no start      | **Set start here**                                                                           |
| start, no end | **Set end here** · **Add via here**                                                          |
| start + end   | **Add via here** (inserted into the nearest leg) · **Set as new start** · **Set as new end** |

Each placed point snaps to the nearest road (existing `trip-planner-snap`
logic), then the route re-routes live. "Add via" inserts the point into the
ordered waypoint list at the position of the nearest existing leg.

**Stable map (zoom-yank fix).** Adding / moving / reordering / deleting a
waypoint **never** re-centers or re-fits the map. Auto-fit runs **only** on
explicit actions: the first load of an existing trip, and a "Fit route" button.
The current effect that re-fits bounds on every waypoint change is removed from
the edit path (carefully, so initial load still frames the route).

**Editing.** Drag a waypoint pin → live re-route (debounced). Each waypoint has
a popover / side-list row to **change its type** or **delete** it. Reordering
vias in the side list also re-routes. (Grabbing the route line itself to pull
out a new via is deferred; the menu's "Add via" covers it.)

---

## Section 2 — Live-routing architecture

**New stateless endpoint `POST /routing/route` (authed).** Independent of any
trip — used for the live preview while editing.

Request:

```jsonc
{
  "waypoints": [{ "lat": 50.07, "lng": 14.43 }, ...], // ordered, >= 2
  "options": {
    "avoid_highways": false,
    "avoid_tolls": false,
    "avoid_unpaved": false,
    "surfaces": ["asphalt", "concrete"]   // optional filter
  }
}
```

Response:

```jsonc
{
  "geometry": [{ "lat": 50.07, "lng": 14.43 }, ...], // road-snapped polyline
  "distance_km": 88.9,
  "duration_min": 124,
  "avg_quality": 4.0,            // matched from road_segments (PostGIS)
  "curviness_score": 6.1,
  "elevation_gain_m": 540,
  "surface_mix": { "asphalt": 82000, "gravel": 6900 } // metres per surface
}
```

The endpoint:

1. Calls OSRM **multi-via** with all coordinates → one snapped line through them.
2. Enriches the geometry against `road_segments` (reusing the trip-generator's
   enrichment helpers) for quality / curviness / elevation / surface mix.

**OSRM provider extension.** Add `route(waypoints, options)` to the routing
provider, calling `/route/v1/driving/{c1;c2;…;cn}?overview=full&geometries=...`
(plus `exclude=motorway`/`exclude=toll` per options). Today's provider only does
2-point `getAlternatives`; this is additive and reuses the existing
`TARMOTO_OSRM_BASE_URL` config + the `RoutingProvider` interface.

**Frontend live loop.** On any waypoint change (add / drag-end / reorder /
delete), **debounce ~300 ms** → call `/routing/route` → replace the day's
geometry + stats in `useTripStore`. In-flight requests are **cancelled**
(AbortController) when a newer edit arrives; **stale responses are ignored**
(monotonic request id) → the drawn route always matches the latest edits. A
subtle "routing…" indicator shows during the call. The synthetic `buildLegPoints`
builder is **retired** — geometry always comes from the server.

**Performance posture.** One call returns geometry **and** quality stats. If
enrichment ever makes a drag feel sluggish, the fallback is to return geometry
first and stats a beat later — but we start single-call and only split if
measured latency demands it.

---

## Section 3 — Self-hosted OSRM (Docker)

**New OSRM service** in `infra/docker/` (own compose file or added to the
stack), running `osrm/osrm-backend` and serving a preprocessed extract via
`osrm-routed --algorithm mld`.

**Preprocessing (scripted, one-time).** `infra/osrm/prepare.sh` downloads a
Geofabrik extract and runs the MLD pipeline (`osrm-extract` → `osrm-partition` →
`osrm-customize`) into a local data volume. The large `.osm.pbf` and processed
files are **git-ignored**; the script + a runbook in `docs/process/` document
fetch/build.

**Region for dev:** **Czech Republic** extract (~200 MB, fast) — matches the
demo data. Runbook documents swapping to a larger Central-Europe extract for
staging/prod.

**Profile:** stock **car** profile (correct road-following). Curvy/motorcycle
profile is a later phase.

**Wiring:** `osrm-routed` on `:5000`; backend `TARMOTO_OSRM_BASE_URL` →
`http://localhost:5000` (local) or the compose service name (in-stack). No
provider rewrite — just the new `route()` method.

---

## Section 4 — Data model & persistence

**No schema/migration change** — reuse `Trip` / `TripDay` / `TripWaypoint`. The
single live route maps to **day 1**: `TripDay.route_geom` (snapped LineString) +
`distance_km`, `avg_quality`, `curviness_score`, `elevation_gain/loss`,
`estimated_time`; placed points → `TripWaypoint` rows (sequence, location, name,
`waypoint_type` start/via/end, `road_segment_id`).

**Save = waypoints-only; server is the source of truth.** New endpoint
`PUT /trips/:tripId/route`:

```jsonc
// request
{ "waypoints": [{ "lat", "lng", "name?", "type": "start|via|end" }], "options": { ... } }
// response: TripDetailDto (the persisted trip)
```

The server **re-routes via OSRM + re-enriches** from the waypoints and persists
`TripDay` + `TripWaypoint`. We never trust client-sent geometry; the saved route
is authoritative. (The tiny chance it differs from the live preview — OSRM data
changing mid-session — is negligible.) Save is **disabled** until there is a
valid routed start→end.

**Retire synthetic pieces.** `trip-planner-builder`'s procedural geometry +
hash-seeded segment stats are removed; the sidebar shows **real** overall stats
(distance / time / quality / curviness / surface mix). A fine-grained
per-segment list stays lightweight or comes later.

**Generate button demoted.** The auto 3-option `POST /trips/:id/generate` flow is
**hidden** for Phase 1 (it returns with multi-day). The backend endpoint stays;
only the planner UI hides the button so manual editing is the single clear flow.

---

## Section 5 — Edge cases & error handling

- **OSRM down / call fails:** non-blocking toast ("Couldn't compute the route —
  retrying on next edit"); keep the last good route line; no crash.
- **Unroutable points** (no connected road / across water): OSRM returns no
  route → clear inline message ("No road route between these points"), keep prior
  geometry and the rider's waypoints.
- **Races:** debounce + cancel in-flight + ignore stale responses.
- **< 2 waypoints:** show the pins, no route, no error. Save disabled.
- **Snapping:** a point far from any road still drops; OSRM snaps it to the
  nearest road for routing (placement keeps existing snap-to-road).
- **Initial load:** auto-fit runs **once** when opening an existing trip; never
  again during editing.
- **Offline:** routing needs the backend; show the app's existing offline state;
  fail gracefully.

---

## Section 6 — Testing

**Backend (mocked OSRM, no live engine in CI):**

- OSRM provider `route()` — builds the right multi-coord URL + option excludes;
  parses geometry/distance/duration.
- `POST /routing/route` — returns geometry + quality enrichment; option
  filters applied; error paths (OSRM failure → 502/handled).
- `PUT /trips/:tripId/route` — persists `TripDay` + `TripWaypoint` from
  waypoints; re-routes server-side; ownership/auth gating.

**Frontend (pure logic + mocked api; MapLibre gestures stay manual/e2e):**

- State-aware context-menu option builder (table in Section 1).
- Debounced live-routing trigger: cancels in-flight, ignores stale, updates the
  store.
- No-auto-fit-on-edit (auto-fit only on load / explicit fit).
- Save gating (disabled until valid route).

**Manual/e2e scenarios (documented):** place start+end → road-following route
appears; drag a point → re-route; zoom is preserved across edits; add a via →
route threads through it; save → trip persists and reopens framed.

---

## API surface (new)

| Method | Path                   | Purpose                                                      | Auth            |
| ------ | ---------------------- | ------------------------------------------------------------ | --------------- |
| `POST` | `/routing/route`       | Stateless live preview: waypoints → snapped geometry + stats | required        |
| `PUT`  | `/trips/:tripId/route` | Persist the manual route (server re-routes from waypoints)   | required, owner |

No DB migration. OpenAPI + generated client regenerated for the two endpoints.

## Open questions

None blocking. Multi-day, curvy routing, and auto-generation are explicitly the
next phases and out of scope here.
