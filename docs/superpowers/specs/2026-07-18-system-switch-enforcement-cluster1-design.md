# System-Switch Enforcement — Third-Party-Source Cluster (Phase 3, PR 1) — Design

- **Date:** 2026-07-18
- **Status:** Approved (design); pending implementation plan
- **Builds on:** the system-switch mechanism shipped in #1036 — the `kind: "system"` registry, the 14 `sys_*` keys, the pure `resolveSystemSwitch`/`buildSystemSwitchSnapshot`, `FeatureResolver.getSystemSwitches()`, and the `/admin/system-switches` operator surface. Catalog: `docs/feature-flags.md` §3.
- **Scope:** the FIRST enforcement PR — wire backend enforcement for the four **third-party-data-source** switches (catalog §3.2) whose degradations are cleanest, establishing the reusable helper + service-level graceful-degradation pattern that later enforcement PRs copy.

## 1. Background & motivation

The system-switch mechanism ships defined-but-unwired: `getSystemSwitches()` has zero production callers. A kill switch that stops nothing has no operational value. This PR makes the first four switches real — the operator-facing point of a system switch is being flippable in an incident (provider outage, quota exhaustion, bad third-party data), so these third-party-source switches are the highest-value first slice.

Enforcement for a system switch is **graceful degradation, not a 403** (unlike entitlement flags): the catalog states switches "degrade gracefully (feature hidden or falls back, no error states)." So the pattern is a service-level read of the switch at the subsystem's natural point, returning an empty/neutral payload when off — never throwing.

## 2. Decisions (user-confirmed)

1. **First PR = the four §3.2 third-party-source switches**: `sys_weather_provider`, `sys_nap_conditions`, `sys_nap_routing_avoidance`, `sys_mapillary_previews`. The other enforceable switches (push w/ safety carve-out, gamification multi-point, ride-publishing write-path, community-collections, reviews, surface-upload) are follow-up PRs.
2. **Graceful degradation, not throwing** — each point returns its empty/neutral shape when the switch is off.
3. **A single resolver helper** — `FeatureResolver.isSystemSwitchEnabled(key)` — read at each point; no cache (kills are immediate), consistent with the existing no-cache resolver design.

## 3. Design

### 3.1 The enforcement helper (`FeatureResolver`)

`apps/backend/src/modules/features/feature-resolver.service.ts` gains:

```ts
/**
 * Whether an operator kill switch is currently ON (default) — false only
 * when an operator has force_off'd it. One indexed read; no cache, so a
 * disable takes effect on the next request. Callable from public and
 * authed endpoints (system switches are global — no user).
 */
async isSystemSwitchEnabled(key: SystemFeatureKey): Promise<boolean> {
  const states = await this.getGlobalStates();
  return resolveSystemSwitch(key, states[key]);
}
```

Reuses the existing `getGlobalStates()` (one `feature_states` read) and the pure `resolveSystemSwitch`. `getSystemSwitches()` stays as the full-map variant (unused by this PR; kept for future bulk consumers).

Each of the three consuming modules (`weather`, `closures`, `mapillary`) adds `FeaturesModule` to its `imports` (it is not `@Global`) and injects `FeatureResolver`.

### 3.2 `sys_weather_provider` → `WeatherService.getRouteWeather`

`apps/backend/src/modules/weather/weather.service.ts`. At the top of `getRouteWeather(route)`:

```ts
if (
  !(await this.featureResolver.isSystemSwitchEnabled("sys_weather_provider"))
) {
  return { points: [], has_alerts: false, alerts: [], typed_alerts: [] };
}
```

(Match the exact empty shape of `WeatherRouteResponseDto` — confirm field names against the DTO when implementing.)

**Deliberately NOT gated: `getCurrentWeather`.** It is shared with (a) the safety severe-weather sweep (`jobs/processors/weather-alert-sweep.processor.ts:202` calls it directly) — safety alerts must never be operator-silenced — and (b) commute weather (`commute.service.ts:432`). The switch's named scope is "weather-along-route," which is exactly `getRouteWeather` (only the user-facing `POST /weather/route` reaches it). Gating `getCurrentWeather` is explicitly out of scope; a future PR that wants it must gate at the controller (`GET /weather/current`) so the sweep's direct service call stays live.

### 3.3 `sys_nap_conditions` → `ClosuresService` (display)

`apps/backend/src/modules/closures/closures.service.ts`. Gate the three public read methods:

- `list(...)` → `[]`
- `checkRoute(...)` → `{ closures: [], full_count: 0, partial_count: 0, advisory_count: 0 }`
- `getById(id)` → `throw new NotFoundException(...)` (the switch hides the display surface; a 404 is the existing "closure not found" shape, not an error state)

(Confirm the exact `checkRoute` response shape against its DTO when implementing.)

The NAP **ingest** (`NapService.poll`) is untouched — closures keep being ingested into `road_closure`; only the display is hidden, so re-enabling is instant with no data gap.

### 3.4 `sys_nap_routing_avoidance` → `ClosuresService.exclusionPolygons`

Same file, separate method — independent of §3.3:

```ts
async exclusionPolygons(...): Promise<Polygon[]> {
  if (!(await this.featureResolver.isSystemSwitchEnabled('sys_nap_routing_avoidance'))) {
    return [];
  }
  // ...existing polygon production...
}
```

The two confirmed consumers — `trips/trip-generator.service.ts:218` and `commute/commute.service.ts` (`:349`, `:587`) — pass the result to the routing provider as `exclude_polygons`; both Valhalla and GraphHopper treat an empty array as "omit exclusions." So routing avoidance stops while closure display (§3.3) is independently controllable.

### 3.5 `sys_mapillary_previews` → `MapillaryService`

`apps/backend/src/modules/mapillary/mapillary.service.ts`. The graceful shapes already exist:

- `segmentImagery(...)` → return the existing `NO_IMAGERY` constant (all-null `{ imageId, capturedAt, attribution, link }`) when off, before hitting the provider.
- `thumbnail(...)` → return `null` when off (the roads controller already 404s on null).

So a switch-off short-circuits to the module's own already-tested empty shapes — no new response shape invented.

### 3.6 Testing

- **Resolver**: `isSystemSwitchEnabled` — force_off ⇒ false, absent/force_on ⇒ true (one focused unit test alongside the existing `getSystemSwitches` test).
- **Each of the four points** (service specs, mocking `FeatureResolver`): switch off ⇒ the degraded shape (empty/zeroed/NO_IMAGERY/404) and the underlying provider/repo is NOT called; switch on (or absent) ⇒ existing behavior unchanged (the existing tests already cover on-behavior; add the off-case). For `exclusionPolygons`, assert the off-case returns `[]` and the polygon query is skipped.
- Existing weather/closures/mapillary suites must stay green — their `FeatureResolver` stub defaults to enabled (`true`) so on-behavior tests are unaffected.

## 4. Out of scope (follow-ups)

- **The remaining enforceable switches**, each its own PR: `sys_push_notifications` (needs a safety denylist — `hazard_alert`/`weather_alert`/`crash_followup` must bypass; the existing `CRITICAL_NOTIFICATION_CATEGORIES` only covers `crash_followup`), `sys_gamification` (badges + challenges + leaderboards — multi-point), `sys_ride_publishing` (write-path force-private semantics), `sys_community_collections`, `sys_poi_ratings` (= road-segment reviews — confirm naming intent), `sys_surface_upload`.
- **`getCurrentWeather`** gating (see §3.2 — needs controller-level surgery to preserve the safety sweep).
- **Not enforceable here:** `sys_booking_affiliate` (no affiliate code exists) and `sys_aerial_basemap` (ČÚZK raster loads client-side — no backend surface).
- **Client consumption** of the resolved switch map (separate workstream).
