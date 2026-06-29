# Route Planner Phase 2 — Manual Multi-Day Planning

**Status:** Design approved (brainstorming), pending spec review
**Builds on:** Phase 1 — [2026-06-26-route-planner-live-routing-design.md](2026-06-26-route-planner-live-routing-design.md) (merged in #717)

## Goal

Extend the Phase 1 single-day manual planner to **N days**: the rider places and
live-routes waypoints per day, navigates days via tabs, and saves the whole
multi-day trip. Consecutive days form a continuous tour via a **live, overridable
overnight link**.

## Scope

In scope: manual multi-day planning that builds directly on Phase 1's manual,
road-snapped, server-routed model.

Explicitly **out of scope** (deferred, unchanged from Phase 1's non-goals):
multi-day **auto-generation** (Calimoto-style curvy round-trip generation), a
curvy/motorcycle routing profile, multi-day suggestion scoping, and
collaborative co-editing. Auto-generation remains a later phase.

## Core model decisions (from brainstorming)

1. **Manual multi-day**, building on Phase 1 — not auto-generation.
2. **Chained, overridable** days: day N+1's start defaults to day N's end.
3. **Live overnight link until overridden:** editing day N's end moves day N+1's
   linked start and re-routes both; placing a fresh start on day N+1 breaks the
   link for that boundary (override). A "link to previous day" affordance
   re-links.
4. **All days on the map, color-coded, with a focus toggle** to isolate the
   selected day.
5. **Overnight-link representation: linked-flag** (`startLinked` per day). Each
   day owns its waypoints; the flag drives the live mirror.

---

## 1. Data model & the linked-start invariant

### Frontend (`TripDay` in `@/lib/types`)

Add one field: `startLinked: boolean` — "this day's start mirrors the previous
day's end." Day 1 ignores it (no predecessor); default `false`.

### Store invariant

Enforced centrally (the same helper region that Phase 1 uses to clear stale
geometry — `updatePlannerDayRoute` and friends in `apps/companion/src/stores/trip.ts`):

> For every day N ≥ 2 with `startLinked === true`,
> `day[N].start.location === day[N-1].end.location`.

Two mutations maintain it:

- **Editing day N's end** (place / drag / remove): if day N+1 is linked, copy
  the new end location into day N+1's start and mark **both** days
  route-preview-stale (both re-route).
- **Placing a start on day N+1** via the context menu: sets
  `startLinked = false` (override).

If day N has no end yet, day N+1's linked start stays empty until day N gets an
end, then seeds automatically.

### Backend

Additive migration: `start_linked boolean NOT NULL DEFAULT false` on
`trip_days` (TypeORM entity + migration). The multi-day save writes it per day;
`TripDetailDto` returns it per day so a reloaded trip restores link state.
Existing single-day trips default to `false` — no data fix-up.

### Day lifecycle

- **Add day**: creates an empty day N+1 with `startLinked: true`, start seeded
  from day N's end (or empty if day N has no end yet).
- **Remove middle day**: re-evaluate the newly-adjacent boundary — if the day
  below was linked, it re-links to the new predecessor's end; otherwise it
  keeps its own start.
- **Relink**: a "link to previous day" affordance sets `startLinked = true` and
  re-seeds the start from the predecessor's end (inverse of override).

---

## 2. Frontend (store, planner page, map)

### Store generalization

Phase 1's mutations hardcode `days[0]`; they become **selected-day**-aware:
`placeWaypoint`, `setWaypointType`, `removeWaypointById`, `applyRouteResult`,
and `routePreviewStale` move from a single value to **per-day** (the day, not
the trip, is stale/fresh). New actions: `addDay()`, `removeDay(index)`,
`setSelectedDay(index)`, `relinkDayStart(index)`. The linked-start sync lives in
the same central helper that clears stale geometry.

### Per-day live routing

The live hook routes the **selected** day on edit (Phase 1 behavior). New rule:
**route every day whose `routePreviewStale` is true, selected day first** — so
an overnight edit that cascades staleness to the linked neighbor re-routes it
too. Each day is an independent Valhalla call writing into that day's geometry.

### Day navigation

The existing day-tabs scaffold (`selectedDayIndex` in the planner page) becomes
real: one tab per day with a distance/duration summary, a "+" to add a day, and
a remove control. Switching tabs sets the selected day; the context menu and
routing target it.

### Map (`TripPlannerMap`)

Render every day's route color-coded (a stable per-day palette), the selected
day emphasized and interactive, others dimmed/non-interactive — plus a **focus
toggle** to isolate the selected day. Waypoint markers are per-day; an overnight
point (a day's end that is also the next day's linked start) renders once,
shared.

### Save gating

`canSaveRoute` generalizes to "≥1 complete day and zero incomplete days, and no
day mid-reroute" (see §4 completeness).

---

## 3. Backend (save contract, routing, migration)

### Save contract

`PUT /trips/:id/route` body generalizes from one day to **multi-day**:

```
{
  days: [{ dayNumber, startLinked, waypoints: [{ lat, lng, name?, type }] }, …],
  options: { avoid_highways?, avoid_tolls?, … }
}
```

Single-day is just `days` of length 1 — uniform shape. `saveManualRoute` keeps
its pessimistic lock + transaction but now **replaces every day**: per day it
re-routes from the waypoints via the provider (never trusting client geometry),
runs enrichment, and writes `trip_days` + `trip_waypoints` + `start_linked`.

### Validation (per day)

All Phase 1 per-route validation runs **per day**: exactly-one ordered
start→end, `@ArrayMaxSize` on waypoints (50), WGS-84 coordinate bounds. Add an
`@ArrayMaxSize` on the `days` array — a max-days cap of **14**.

### Routing cost

Save becomes N Valhalla calls (one per day) inside the transaction — acceptable
for realistic day counts; the day cap bounds it.

### Contract sync

Regenerate OpenAPI + the companion client; update shared types. Mobile does not
consume this endpoint yet, so the companion is the only client to update.

### Unchanged from Phase 1

`trip:updated` broadcast, `activity.recordSafe`, membership/lock model all carry
over. Suggestion-unscoping stays day-1-scoped (multi-day suggestion scoping is
out of scope).

---

## 4. Edge cases & error handling

- **Day completeness:** _empty_ (no waypoints), _incomplete_ (waypoints but no
  valid ordered start→end), or _complete_ (routable). Save is enabled only with
  ≥1 complete day and **zero** incomplete days; **empty days are dropped on
  save** (a freshly-added unfilled day won't block; a half-placed one will).
  After dropping empties, remaining days are **renumbered contiguously**
  (`dayNumber` 1..M) before persistence so there are no gaps.
- **Linked start, no predecessor end:** linked start stays empty until the
  predecessor gets an end, then seeds.
- **Removing days:** can't remove the last remaining day (min 1); removing a
  middle day re-evaluates the adjacent boundary (§1).
- **Per-day route failure:** a day whose route returns no path (502/null) shows
  no geometry + a non-blocking error; save stays disabled for that day (Phase 1
  degradation, per day).
- **Caps:** max-days **14** and per-day **50** waypoints, enforced client- and
  server-side.

---

## 5. Testing

- **Store:** per-day mutations; link sync (edit day N end → day N+1 start moves,
  both stale); override breaks the link; relink restores it; add/remove day;
  save-gating across mixed empty/incomplete/complete days.
- **Backend:** multi-day save replaces all days with per-day routing +
  enrichment + `start_linked` persistence; per-day validation; max-days cap; the
  migration.
- **Map/page:** day tabs + summaries; all-days color-coded render + focus
  toggle; selected-day routing.
- **E2E:** build a 2-day trip, save, reload → link state and both routes
  restored.

---

## Risks / open questions

None blocking. The main new complexity is the per-day routing + live overnight
sync in the store; the linked-flag model keeps it explicit and testable.
Auto-generation and curvy routing remain explicitly out of scope.
