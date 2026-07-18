# System-Switch Enforcement — Community & Social Cluster (Phase 3, PR 2) — Design

- **Date:** 2026-07-18
- **Status:** Approved (design); pending implementation plan
- **Builds on:** the system-switch mechanism (#1036) and the first enforcement cluster (#1038), which established `FeatureResolver.isSystemSwitchEnabled(key)` + the service-level graceful-degradation pattern (and the "scope to your own data, not the whole shared surface" lesson from the NAP fix). Catalog: `docs/feature-flags.md` §3.3.
- **Scope:** wire backend enforcement for the three **community & social** switches — `sys_ride_publishing`, `sys_community_collections`, `sys_poi_ratings` — across five modules (sharing, rides, route-collections, reviews, roads).

## 1. Background & motivation

These switches are moderation/incident kill toggles ("moderation incident", "review spam wave"). Cluster 1 covered the third-party-source switches; this cluster covers the user-generated-content ones. The mechanism (`isSystemSwitchEnabled`) already exists — this PR adds the enforcement reads at each subsystem's natural point.

Two things make this cluster more nuanced than cluster 1's clean read-degradations, and both are settled below: some points are **writes** (which can't "degrade to empty"), and one switch's data **leaks into a second service's response** (the #1038 trap).

## 2. Decisions (user-confirmed)

1. **All three §3.3 switches** in one PR.
2. **Write degradation = a clean 503.** A gated WRITE returns `ServiceUnavailableException` ("… temporarily unavailable") — honest, not a 500 crash, and not a dishonest fake-success. The "never throw" rule from cluster 1 applies to READ/display paths (which still degrade to empty); a write must persist or fail. **`delete`/withdraw paths always stay allowed** (a kill must never trap user content).
3. **`sys_community_collections` gates the community BROWSE feed only** (`listDiscover`). Direct share-links (`GET /collections/by-slug/:slug`) stay open — a point-to-point link isn't "browsing", and pulling a specific bad collection is a per-collection moderation action, not this global switch.

## 3. Design

All three reuse `FeatureResolver.isSystemSwitchEnabled(key)` (on unless `force_off`; one indexed read, no cache). Each consuming module adds `FeaturesModule` to its `imports` (not `@Global`) and injects `FeatureResolver`. **Testing rule (from #1038):** every gated method's off-case test asserts `toHaveBeenCalledWith('<the exact key>')` so a future key-swap between methods can't pass — plus, for the multi-point switches, tests that the correct method uses the correct key.

### 3.1 `sys_ride_publishing` — block making rides public (directional, two paths)

`shared_rides` is single-purpose (each row is a ride publication; `is_public` is the state). The gate is **directional** — block only the `is_public → true` direction; unpublishing and reads stay live.

- **`SharingService.toggleShare(userId, rideId, isPublic)`** (`sharing.service.ts:53`, `POST /rides/:rideId/share`): when the switch is off **and** `isPublic === true`, coerce `isPublic` to `false` before the create/flip, so the ride is saved/returned **private** (no throw; the client gets a private `SharedRideResponseDto`). `isPublic === false` (unpublish) is unaffected.
- **`RidesService.applyDefaultRideSharing(userId, rideId)`** (`rides.service.ts:164`, best-effort auto-publish on `RidesService.stop()` when the rider's `default_ride_sharing === 'public'`): early-return when the switch is off (skip the auto-publish). Already best-effort, so skipping is trivially graceful. This is the easy-to-miss second write path.
- **Untouched (reads + withdrawal):** `getByToken`, `listCommunityRides`, `listForUser`, `like/unlike/clone`, the followed-riders feed, and `SharingService.unshare` (DELETE) — all stay live.
- **Modules:** `sharing` adds `FeaturesModule`; `rides` already imports it — only `RidesService` needs the `FeatureResolver` injection.

### 3.2 `sys_community_collections` — hide the community browse feed

The personal library and community browse are **distinct methods** (not one param-filtered query), so no scoping predicate is needed — gating the community method can't touch the personal library.

- **`RouteCollectionsService.listDiscover(...)`** (`route-collections.service.ts:98`, `GET /collections/discover`): when off → return the empty page shape `{ items: [], total: 0, limit, offset }` (match `RouteCollectionDiscoverResponseDto` field names when implementing).
- **Untouched:** `getBySlug`/`getPreviewBySlug` (direct share-links — decision 3), `listMine`/`listLibrary` (personal library, incl. followed collections), and all owner CRUD.
- **Module:** `route-collections` adds `FeaturesModule`.

### 3.3 `sys_poi_ratings` — hide reviews (reads) + block review writes; **two services**

`road_reviews` is single-source (all rows are rider road-segment ratings), so no predicate — but the aggregate **leaks into the road-detail DTO via a second service** (the #1038 trap). Both surfaces must be gated.

- **Reads → degrade to empty:**
  - `ReviewsService.listForSegment(segmentId, viewerUserId)` (`reviews.service.ts:200`, `GET /roads/:segmentId/reviews`) → `[]`.
  - `RoadsService.findById(segmentId)` (`roads.service.ts:355`, `GET /roads/:segmentId`) → zero the embedded review aggregate: `review_count: 0`, `avg_review_rating: null`, `recent_reviews: []` (skip the review sub-query when off, or zero its output — match the method's real structure). **This is the leak-fix: without it, ratings survive on the road page after the reviews panel is killed.**
- **Writes → clean 503** (`ServiceUnavailableException('Reviews are temporarily unavailable')`): `create` (`:249`), `update` (`:328`), `castVote` (`:589`), `clearVote` (`:629`), `uploadPhotos` (`:443`). **`delete` (`:385`) stays allowed** (withdrawal).
- **Modules:** `reviews` adds `FeaturesModule`; **`roads` also adds `FeaturesModule`** (it doesn't import it today) and `RoadsService` injects `FeatureResolver`.

### 3.4 Testing

- **Per gated method**: off ⇒ the degraded shape (private/empty/zeroed) or the 503 for writes; on/absent ⇒ existing behavior unchanged; the provider/repo write is not persisted when off. Each off-case asserts `toHaveBeenCalledWith('<key>')`.
- **Directional (ride_publishing):** off + `is_public=true` ⇒ result is private; off + `is_public=false` ⇒ still unpublishes; `applyDefaultRideSharing` off ⇒ no share row created.
- **Scope guards:** a personal-library method (`listMine`) is NOT gated by `sys_community_collections`; `RoadsService.findById` on ⇒ real aggregate, off ⇒ zeroed (the leak test).
- **Writes:** `create`/`castVote` off ⇒ 503; `delete` off ⇒ allowed.
- Existing suites stay green — each module's new `FeatureResolver` stub defaults `isSystemSwitchEnabled` → `true`.

### 3.5 Contract

No DTO/endpoint shape changes — responses keep their shapes (just empty/private/zeroed when off). The write-path 503 is a runtime behavior (like the `FEATURE_LIMIT_EXCEEDED` 403), not a schema change; `openapi:gen` shows zero drift.

## 4. Out of scope (follow-ups)

- **Remaining enforceable switches:** `sys_surface_upload` (sensor ingest — clean), `sys_gamification` (badges + challenges + leaderboards — multi-point), `sys_push_notifications` (needs a safety denylist so `hazard_alert`/`weather_alert`/`crash_followup` bypass it).
- **Not backend-enforceable:** `sys_booking_affiliate` (not built), `sys_aerial_basemap` (client-only).
- **Client consumption** of the resolved switch map.
