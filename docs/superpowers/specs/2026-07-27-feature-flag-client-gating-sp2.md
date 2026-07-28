# SP2 — Feature-flag client gating (mobile + companion) — Design

**Status:** approved scope (epic part B). Depends on SP1 (backend paid gates, merged `3a96276f`).

**Goal:** Make both clients proactively hide/disable/upsell the paid features that today only fail with a raw server 403 for Free riders, using each app's existing entitlement infrastructure. No new infra, no backend changes.

## Background

SP1 enforces 9 entitlements server-side. Clients currently gate only a subset:

- **Mobile** gates `gpx_export` (3 screens) + `road_quality_max_zoom` (map zoom clamp).
- **Companion** gates `gpx_export`, `max_active_trips`, `max_trip_collaborators`, `road_quality_max_zoom`.

Everything else reaches a raw 403 (or, for `advanced_ride_stats`, silently-nulled fields) with no explanation or upsell. SP2 closes those gaps.

Both apps already have the full toolkit — no new components:

- Mobile: `useFeature`/`useLimit`/`useEntitlements` (fail-closed) + `UpgradePrompt` modal (`apps/mobile/src/components/entitlements/UpgradePrompt.tsx`). No paywall screen; IAP not built, so the CTA renders disabled "Coming soon" (accepted — payment flow is a known separate gap).
- Companion: `useEntitlements`/`useFeature`/`useLimit`/`useRoadQualityZoomCap` + `UpgradePrompt` (inline|modal) + `FeatureGate` (`apps/companion/src/components/entitlements/`). CTA routes to `/settings/subscription` (Stripe).

## Established gate pattern (replicate; do NOT invent new mechanics)

1. Resolve: `const { enabled, isResolved } = useFeature(KEY)` (or `useLimit`) + tier from `useEntitlements`.
2. Fail closed: treat `!isResolved` as not-yet-known — disable the control, never act as unlimited.
3. Proactive: when `isResolved && !enabled` (or at/over a resolved limit), block the action and show `UpgradePrompt` instead of firing the request.
4. Reactive safety net: in the action's catch, on `ApiError.status === 403` (limits: body `code === FEATURE_LIMIT_EXCEEDED`) open the same prompt — covers a revoke between snapshot refresh and action.
5. Copy: pre-localized `message` via each app's i18n (`translate`/`t`). Every new string MUST be added to all locale catalogs or the catalog completeness test fails.

`advanced_ride_stats` is **display-gating**, not an action block: the backend already nulls the fields, so the client shows **locked teaser tiles + an upsell CTA** where the values would be (user-approved treatment), never a blank gap.

## Delivery: two PRs under this one spec

### PR A — Mobile (`feat/feature-flag-gating-mobile`), scope `mobile`

Five gaps. Each gate goes at the slot the exploration identified; each ships with its upsell copy added to `apps/mobile/src/i18n/locales/en.ts`.

| #   | Feature/limit                                                | Screen (slot)                                                                                                                                       | Treatment                                                                                                                                     |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `commuter_mode` (toggle, Pro)                                | `CommuteScreen.tsx` — gate whole screen after `useCommute()` (~L112)                                                                                | Locked screen state + `UpgradePrompt`; block the `useCommute` fetch path so no 403                                                            |
| M2  | `group_rides` (toggle, Premium)                              | `GroupRideScreen.tsx` — gate `idle` create/join UI (~L102); guard `handleCreate` (L236) + `handleJoin` (L257)                                       | Upsell instead of create/join form; 403 safety net                                                                                            |
| M3  | `max_active_trips` (limit, Free=1)                           | `TripsScreen.tsx` "New trip" FAB (L134) — count already loaded there                                                                                | Disable FAB at cap + `UpgradePrompt`; 403 (`FEATURE_LIMIT_EXCEEDED`) safety net in `TripCreateScreen` `handleGenerate`/`handleImport` catches |
| M4  | `offline_maps` (toggle, Pro) + `max_offline_regions` (limit) | `OfflineRegionsScreen.tsx` — gate screen/entry on `offline_maps`; gate "Save current area" (L115/L195) on `max_offline_regions` vs `regions.length` | Feature gate on screen; limit gate on save button                                                                                             |
| M5  | `advanced_ride_stats` (toggle, Pro)                          | `RideDetailScreen.tsx` — `StatsGrid` elevation rows (L347/L352) + Max-lean tile (L362) + `LeanBreakdownCard` (L374)                                 | Locked teaser tiles + upsell (display-gating)                                                                                                 |

Notes:

- M3 needs the owned-trip count. Prefer gating at `TripsScreen` where the list is loaded; pass `resolvedLimit` into `UpgradePrompt` as `{ limit: "max_active_trips", resolvedLimit }`. Use shared `isWithinLimit`.
- M4: `max_offline_regions` cap is currently a local tile/count concept; wire it to the resolved limit. If `offline_maps` is off, the whole screen is a locked upsell (entry from `SettingsScreen.tsx:697`).
- M5: because data is already null, "locked" means a placeholder tile, not a blurred real value.
- Full-zoom (`road_quality_max_zoom`) already handled — out of scope.

### PR B — Companion (`feat/feature-flag-gating-companion`), scope `companion`

Two gaps.

| #   | Feature                             | Surface (slot)                                                                                                                                          | Treatment                                                                              |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| C1  | `advanced_ride_stats` (toggle, Pro) | `rides/[rideId]/page.tsx` (lean L275/797, elevation L233-286, `LeanDistribution` ~L670); `RideDetailSidebar.tsx` (L125,157-169); `rides/stats/page.tsx` | Locked teaser tiles + `UpgradePrompt`/`FeatureGate` where the paid tiles render        |
| C2  | `collaborative_trips` (toggle, Pro) | `TripCollaborateModal.tsx` Invite-link tab (L454-587) + the Collaborate entry in `trips/planner/page.tsx` (`collaborateOpen`)                           | `FeatureGate`/toggle check so a persisted-trip share/invite isn't fired into a raw 403 |

Notes:

- The `max_trip_collaborators` LIMIT is already gated (People tab). C2 adds the `collaborative_trips` TOGGLE gate that SP1 enforces on persisted-trip share/invite. A Free user (collaborators=0) is already blocked from inviting; C2 additionally gates the share-link generation and the collaborate entry so the toggle-off 403 is never hit raw.
- Snapshot-only preview shares stay OPEN to all tiers (SP1 scoped the backend gate to a persisted `trip_id`) — do NOT gate a share that isn't attached to a saved trip.

## Testing

- Mobile: each gate gets a component/logic test proving (a) resolved-not-entitled → prompt shown / action not fired; (b) resolved-entitled → normal; (c) unresolved → fail-closed disabled. Extend catalog test with new keys. Follow the existing `gpx_export`/`MapScreen.entitlement` test style.
- Companion: gating tests in the existing entitlement test style (`FeatureGate`/hook consumers); for C1 assert the locked tiles render for a non-entitled snapshot and real tiles for an entitled one. Companion CI typechecks test files — run `tsc` after editing tests.

## Out of scope / non-goals

- No IAP / paywall screen on mobile (payment flow is a separate known gap). Mobile CTA stays informational.
- No backend, DTO, or OpenAPI changes.
- Already-gated surfaces (mobile gpx/full-zoom; companion gpx/max_active_trips/max_trip_collaborators/full-zoom) are untouched.
- `road_quality_full_zoom` toggle stays unused; both apps keep the numeric-limit model.
- SP3 (`sys_*` switches) and SP4 (Free kill-switches) are separate sub-projects.

## Risks

- Fail-open regressions: a gate that treats `!isResolved` as entitled would flash paid UI. Mitigated by the fail-closed hook contract + explicit `isResolved` checks in tests.
- i18n catalog drift: missing locale keys break the completeness test — add keys to every catalog in the same task.
- Over-gating snapshot-only trip shares on companion (C2) would break the free preview flow — the gate must key on a persisted `trip_id`.
