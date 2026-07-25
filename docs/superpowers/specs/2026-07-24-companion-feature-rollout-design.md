# Companion Feature Rollout — Design

**Date:** 2026-07-24
**Status:** Approved (brainstorm)
**Scope:** Sub-project 2 of the "client consumption of entitlements" epic.

## Background

Sub-project 1 (PR #1078, merged) shipped the companion entitlement foundation —
`useEntitlements`/`useFeature`/`useLimit` hooks, `<UpgradePrompt>` (inline +
modal), `<FeatureGate>`, `parseFeatureLimitError`/`tierLabel` helpers — and
proved them end-to-end on the `max_active_trips` limit (trips page + planner).

`max_active_trips` is currently the **only** flag/limit wired to any companion
UI. This sub-project wires the primitives to the **remaining companion-gateable
features**.

### What is actually gateable on the companion

A reconnaissance of `apps/companion/src` against every non-free catalog key
found that most of the catalog has **no companion surface** — it is mobile-only
or not built:

| Key                                                                 | Companion surface?                          | Disposition       |
| ------------------------------------------------------------------- | ------------------------------------------- | ----------------- |
| `gpx_export` (toggle, pro+)                                         | YES                                         | **In scope**      |
| `max_trip_collaborators` (limit)                                    | YES                                         | **In scope**      |
| `road_quality_max_zoom` (limit) + `road_quality_full_zoom` (toggle) | YES                                         | **In scope**      |
| `garmin_export` (premium)                                           | No (comment prose only)                     | out — not built   |
| `offline_maps` (pro+) / `max_offline_regions`                       | No (only a PWA connectivity indicator)      | out — mobile-only |
| `commuter_mode` (pro+)                                              | No (only a ride-TYPE enum)                  | out — mobile-only |
| `group_rides` (premium) / `max_group_ride_members`                  | No (badge + marketing copy only)            | out — mobile-only |
| `api_access` (premium)                                              | No (no developer settings)                  | out — no surface  |
| `hazard_reports_per_day` (limit)                                    | No (companion reads hazards, never reports) | out — mobile-only |

So Sub-project 2 covers exactly **three** surfaces. The mobile-only keys are
Sub-project 3.

### Decisions captured during brainstorming

1. **Scope = all three companion gates** in one sub-project (gpx_export,
   max_trip_collaborators, road-quality zoom).
2. **GPX + collaborator gates use inline disable + modal** (the Sub-project 1
   convention for inline action controls), not `<FeatureGate>` wrapping.
3. **Road-quality is gated on the `road_quality_max_zoom` LIMIT alone.**
   `road_quality_full_zoom` (the pro+ toggle) is just the boolean twin of "the
   cap is lifted", so the limit drives everything and the toggle needs no
   separate gate.
4. **Zoom-clamp UX = clamp the overlay layer's maxzoom AND open the
   `<UpgradePrompt>` modal** when the user zooms the quality overlay past the
   cap (one-shot per session, reusing the Sub-project 1 dismiss pattern).

## Exact catalog values this design relies on (from `packages/shared/src/feature-flags.ts`)

- `gpx_export`: `kind: toggle`, `default: false`, `tiers: PRO_AND_UP` (free =
  off, pro/premium = on).
- `max_trip_collaborators`: `kind: limit`, `default: 0`, `tiers: { free: 0,
pro: 5, premium: null }` (premium = unlimited).
- `road_quality_max_zoom`: `kind: limit`, `default: 12`, `tiers: { free: 12,
pro: null, premium: null }` (pro/premium = unlimited → the existing static
  overlay max, 18).
- `road_quality_full_zoom`: `kind: toggle`, `tiers: PRO_AND_UP` — NOT gated
  directly (subsumed by the limit).

All three ship dark: seeded permissive in launch mode, so the gates are inert
in production until the seed flips. Verification must drive each gate with an
explicit finite/off value, never prod data.

## Components

### 1. `gpx_export` — lock the GPX export controls

Two inline surfaces, both keep CSV export free and gate only the GPX action:

- **`apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.tsx`**
  — the "GPX (tracks)" menu item. `useFeature("gpx_export")`; when not
  `enabled`, render the item in a locked state (Pro affordance) whose click
  opens `<UpgradePrompt variant="modal" capability={{ feature: "gpx_export" }}
currentTier={tier}>` instead of calling `handleExport("gpx")`. The CSV item
  is untouched.
- **`apps/companion/src/components/TripExportButton.tsx`** — the one-click
  "Export GPX" button; same treatment.

Fail closed while entitlements are unresolved (`useFeature(...).isLoading`):
treat as locked, not free — a flash of the free action on a paid feature is the
wrong direction. `tier` for the modal comes from `useEntitlements()`; if `tier`
is unresolved the control simply stays disabled (no modal to render) — the same
"disable, don't wave through" rule as the trips gate.

### 2. `max_trip_collaborators` — gate the invite action

In **`apps/companion/src/components/TripCollaborateModal.tsx`** (`PeopleTab`):

- Roster count = non-owner members + pending invites (already computed in the
  modal, ~lines 291/678). This is the count the backend limit is measured
  against ("collaborators per trip, excluding the owner").
- `useLimit("max_trip_collaborators")`: when `limit !== null && count >=
limit`, disable the Invite button, show a `"{count} of {limit}
collaborators"` counter, and render an inline `<UpgradePrompt
capability={{ limit: "max_trip_collaborators", resolvedLimit: limit }}
currentTier={tier}>`. Free tier (limit 0) → the whole invite affordance is in
  the locked/upgrade state from the start.
- Fail closed on unknown cap (loading / error / unresolved), mirroring the
  Sub-project 1 rule: block the invite until we can prove the roster is under a
  finite cap.
- Safety net: the backend invite endpoint is the hard enforcement. If it
  returns the `FEATURE_LIMIT_EXCEEDED` 403, the invite handler routes it
  through `parseFeatureLimitError` → the same upgrade modal (authoritative
  limit fed in), exactly like the Sub-project 1 mint paths.

### 3. Road-quality zoom clamp — `road_quality_max_zoom`

The quality overlay is rendered by
**`apps/companion/src/components/map/MapCanvas.tsx`** and consumed by the
explore quality map, `PersonalRoadMap`, and the planner quality overlays.

- `useLimit("road_quality_max_zoom")` feeds the quality **overlay layer's**
  `maxzoom` (NOT the base map's): free → 12, pro/premium (`null`) → the existing
  static overlay max (18). Past the layer maxzoom, MapLibre naturally stops
  drawing the overlay — no per-frame JS needed for the clamp itself.
- When the user zooms the map past the cap **while the quality overlay is
  enabled**, open `<UpgradePrompt variant="modal" capability={{ limit:
"road_quality_max_zoom", resolvedLimit: limit }} currentTier={tier}>`. This is
  **one-shot per session** — reuse the Sub-project 1 `...Dismissed` flag so a
  dismissed prompt does not re-fire on every subsequent zoom tick.
- Fail closed on unknown cap: clamp at the free cap (12) until the limit
  resolves, rather than rendering full detail we cannot confirm entitlement for.
- The `road_quality_full_zoom` toggle is intentionally not consulted — the limit
  is the single source of the cap.

## Data flow

```
GET /users/me (react-query cache, Sub-project 1)
  ├─ useFeature("gpx_export")            → RideExportMenu / TripExportButton (lock + modal)
  ├─ useLimit("max_trip_collaborators")  → TripCollaborateModal (counter + block + inline prompt)
  │      backend invite 403 ── parseFeatureLimitError ── modal
  └─ useLimit("road_quality_max_zoom")   → MapCanvas quality overlay maxzoom clamp
         map zoom > cap (overlay on) ── one-shot ── modal
```

## Testing

- **`gpx_export`**: RideExportMenu + TripExportButton unit/component tests —
  off → GPX control locked, click opens modal, CSV still exports; on → GPX
  exports normally; loading → locked (fail closed).
- **`max_trip_collaborators`**: TripCollaborateModal tests — at cap → Invite
  disabled + counter + inline prompt; free (0) → invite affordance locked;
  under cap → invite works; unknown cap → blocked; the invite-403 → modal
  safety net.
- **road-quality zoom**: MapCanvas / overlay tests — resolved limit feeds the
  overlay `maxzoom` (12 free, 18 pro+); zooming past the cap with the overlay on
  opens the modal once (dismiss is one-shot); unknown cap clamps at 12.
  (Follow the existing MapLibre test idioms in the companion — MapLibre renders
  blank in a backgrounded automation tab, so assert layer/style config and the
  clamp value, not rendered tiles.)
- New user-facing strings added once each to the typed `en` catalog; client
  components use `useTranslation()`; run `tsc` after editing tests (companion CI
  typechecks test files).

## Scope boundaries (YAGNI)

- **In scope:** the three gates above, their tests, and their catalog keys.
- **Out of scope:** the mobile client (Sub-project 3); every mobile-only /
  not-built key (garmin_export, offline_maps, max_offline_regions,
  commuter_mode, group_rides, max_group_ride_members, api_access,
  hazard_reports_per_day); a separate `road_quality_full_zoom` toggle gate
  (subsumed by the limit); removing the launch-mode seeds (a go-live task).

## Risks / notes

- **Ships dark:** none of this is visible in prod until the seeds flip; drive
  gates with explicit values in tests, never prod data.
- **Overlay-vs-basemap maxzoom:** the clamp must apply to the road-quality
  overlay layer only — clamping the base map would break normal map use. Verify
  the exact layer id / source the overlay uses in `MapCanvas`.
- **Modal-on-zoom intrusiveness:** the one-shot dismiss is load-bearing — a
  modal that re-opened on every zoom past the cap would be unusable. The
  Sub-project 1 dismiss pattern is the mitigation.
- **Roster-count parity:** the client collaborator count must match what the
  backend counts (non-owner members + pending invites). If they drift, the
  pre-gate and the 403 disagree; the 403 safety net makes any drift fail safe.
