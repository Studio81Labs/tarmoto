# Tarmoto — Feature Flag Catalog

Version 1.0 | July 2026 | Source of truth for the entitlement + operator-switch vocabulary.

Tiers: **Free** ⊂ **Pro** (€29.99/yr) ⊂ **Premium** (€49.99/yr)

> **Status:** this catalog is the target vocabulary. The live registry
> (`packages/shared/src/feature-flags.ts`) currently implements a subset —
> see [§6 Implementation status](#6-implementation-status--reconciliation)
> for exactly what ships today vs. what is planned, and where the live
> architecture intentionally differs from the sketch in §5.

## Resolution model

- The backend resolves the user's tier + operator overrides into one **flat entitlements object**. Clients (app, dashboard, admin) never compute inheritance.
- Resolved entitlements ride on **`GET /users/me`** (and the auth responses) as `{ features: {...}, limits: {...} }`. Global operator overrides for the client kill-switch fast path come from **`GET /api/v1/config/flags`** and **`GET /api/v1/config/limits`**. Short client cache (~5 min TTL) + refresh on app foreground and after purchase.
- **Kill-switch precedence:** registry default → subscription-tier grant → per-user override → **global operator override** (absolute). A global `force_off` (or a limit global value of `0`) disables the feature for everyone regardless of tier; the per-user override is a support lever (grant/revoke or a bespoke limit) that a global clamp still overrides when the clamp is more restrictive.
- Limits use `null` = unlimited. Never ship "unlimited" as a boolean.
- Clients must fail closed on missing flags (treat unknown/absent as `false`, and a missing limit as the most-restrictive `0`), so a server-side removal acts as an implicit kill switch.

---

## 1. Entitlement flags (boolean, per tier)

### 1.1 Free tier (granted to all tiers)

Free-for-everyone features that exist as flags purely for the kill switch.

| Flag                   | Free | Pro | Premium | Description                                                                | Kill-switch scenario                                          |
| ---------------------- | ---- | --- | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `basic_navigation`     | ✓    | ✓   | ✓       | Turn-by-turn navigation                                                    | Routing engine outage → fall back to map-only                 |
| `ride_tracking`        | ✓    | ✓   | ✓       | Ride recording + basic stats                                               | Tracking bug corrupting rides                                 |
| `road_quality_overlay` | ✓    | ✓   | ✓       | Quality-colored overlay (zoom-limited on Free via `road_quality_max_zoom`) | Bad tile build shipped                                        |
| `hazard_alerts`        | ✓    | ✓   | ✓       | Receiving community hazard alerts                                          | Alert spam / false-positive storm                             |
| `hazard_reporting`     | ✓    | ✓   | ✓       | Submitting one-tap hazard reports                                          | Abuse wave; moderation backlog                                |
| `crash_detection`      | ✓    | ✓   | ✓       | Crash detection + emergency contact SOS                                    | **Highest-priority switch**: false SOS alerts are an incident |
| `weather_alerts`       | ✓    | ✓   | ✓       | Severe weather alerts along route                                          | Provider outage / bad data                                    |
| `trip_planning`        | ✓    | ✓   | ✓       | Trip planner itself (count-limited via `max_active_trips`)                 | Planner backend outage                                        |
| `gpx_import`           | ✓    | ✓   | ✓       | Import GPX from other platforms                                            | Parser vulnerability                                          |
| `community_access`     | ✓    | ✓   | ✓       | Browse published rides & collections                                       | Moderation incident                                           |
| `carplay_android_auto` | ✓    | ✓   | ✓       | CarPlay / Android Auto projection                                          | Crash-on-connect regression                                   |

### 1.2 Pro tier (€29.99/yr)

| Flag                     | Free | Pro | Premium | Description                                                       |
| ------------------------ | ---- | --- | ------- | ----------------------------------------------------------------- |
| `road_quality_full_zoom` | ✗    | ✓   | ✓       | Full-depth road quality zoom                                      |
| `offline_maps`           | ✗    | ✓   | ✓       | Offline map region downloads                                      |
| `gpx_export`             | ✗    | ✓   | ✓       | GPX export of rides & planned routes                              |
| `commuter_mode`          | ✗    | ✓   | ✓       | Saved commutes, one-tap commute nav, alternatives, weekly summary |
| `advanced_ride_stats`    | ✗    | ✓   | ✓       | Lean angles, elevation profile, detailed per-ride stats           |
| `collaborative_trips`    | ✗    | ✓   | ✓       | Shared trip planning (size via `max_trip_collaborators`)          |

### 1.3 Premium tier (€49.99/yr)

| Flag                     | Free | Pro | Premium | Description                              |
| ------------------------ | ---- | --- | ------- | ---------------------------------------- |
| `group_rides`            | ✗    | ✗   | ✓       | Real-time group location sharing (US-26) |
| `priority_hazard_alerts` | ✗    | ✗   | ✓       | Priority delivery of hazard alerts       |
| `advanced_analytics`     | ✗    | ✗   | ✓       | Riding analytics dashboard               |
| `api_access`             | ✗    | ✗   | ✓       | Personal API token for ride/route data   |
| `garmin_export`          | ✗    | ✗   | ✓       | Direct route export to Garmin            |

---

## 2. Limits (numeric, per tier)

| Limit                    | Free | Pro    | Premium | Notes                                                                                                                                              |
| ------------------------ | ---- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_active_trips`       | `1`  | `null` | `null`  | Replaces the old `unlimited_trip_planning` boolean. `0` = kill switch for trip creation (existing trips stay readable)                             |
| `max_trip_collaborators` | `0`  | `5`    | `null`  | Collaborators per trip, excluding owner. `0` = solo planning only                                                                                  |
| `max_group_ride_members` | `0`  | `0`    | `null`  | Live group ride size. Kept as a limit so a paid "small groups" tier can be added later without new flags                                           |
| `road_quality_max_zoom`  | `12` | `null` | `null`  | Max zoom level at which quality overlay renders. Tune server-side without app release; pairs with `road_quality_full_zoom` for UI upsell messaging |
| `max_offline_regions`    | `0`  | `null` | `null`  | Offline map regions per user. Gives a future lever (e.g. Pro = 10) without schema change                                                           |
| `hazard_reports_per_day` | `50` | `50`   | `50`    | Anti-abuse rate cap, not a pricing lever. `0` = reporting kill switch                                                                              |

**Convention:** every "unlimited X" marketing promise maps to a limit with `null`, and every limit at `0` is a functional kill switch for that capability.

> **Note on `road_quality_max_zoom`:** unlike the capacity limits, this is a
> ceiling, not a count. `0` here is degenerate (no overlay at all); the Free
> ceiling is `12`. `hazard_reports_per_day` is intentionally flat across
> tiers (a rate cap, not an upsell), which still satisfies the monotone
> free ≤ pro ≤ premium invariant since the values are equal.

---

## 3. System switches (operator-only, no tier)

Not entitlements — global operational toggles for subsystems and third-party dependencies. Default `true`; flipping to `false` degrades gracefully (feature hidden or falls back, no error states). They resolve globally (no tier, no per-user layer) and are served via `GET /api/v1/config/flags` alongside the entitlement kill-switch map.

### 3.1 Data collection pipeline

| Switch                          | Controls                                      | Kill-switch scenario                                         |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `sys_accel_collection`          | Background accelerometer/gyro sampling (50Hz) | Battery-drain regression, sensor bug on specific OS release  |
| `sys_surface_upload`            | Batch upload of surface data to backend       | Ingestion pipeline outage; corrupt data reaching aggregation |
| `sys_surface_ml_classification` | On-device TF Lite classification              | Bad model release → collect raw, classify server-side later  |

Separating collection / upload / classification means a bad model or broken ingestion doesn't force turning off the moat's data collection entirely.

### 3.2 Third-party data sources

| Switch                      | Controls                                            | Kill-switch scenario                                                            |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sys_nap_conditions`        | NAP/DATEX II closure display (CONDITIONS tab + map) | Feed outage, reconcile bug showing stale closures                               |
| `sys_nap_routing_avoidance` | Closures injected as Valhalla `exclude_polygons`    | Bad polygon breaks routing — display can stay on while routing avoidance is off |
| `sys_weather_provider`      | Weather-along-route data                            | Provider outage or quota exhaustion                                             |
| `sys_mapillary_previews`    | Mapillary imagery in Road Preview Cards             | API change / quota; card falls back to measured-quality-only state              |
| `sys_aerial_basemap`        | ČÚZK orthophoto basemap toggle                      | WMTS outage; toggle hidden, base map unaffected                                 |
| `sys_booking_affiliate`     | Booking.com deep links on hotel POIs                | Affiliate account issue; pins stay, links hidden                                |

### 3.3 Community & social

| Switch                      | Controls                             | Kill-switch scenario                             |
| --------------------------- | ------------------------------------ | ------------------------------------------------ |
| `sys_ride_publishing`       | Publishing rides (public/members)    | Moderation incident; existing content unaffected |
| `sys_community_collections` | Community collections browsing       | Same                                             |
| `sys_poi_ratings`           | Rider ratings & stop reviews (US-25) | Review spam wave                                 |

### 3.4 Growth & engagement (Phase 2/3 — reserve names now)

| Switch                   | Controls                                                                         |
| ------------------------ | -------------------------------------------------------------------------------- |
| `sys_gamification`       | Badges, challenges, personal road map (Epic 7)                                   |
| `sys_push_notifications` | Non-critical push (marketing, engagement). Safety alerts are **not** behind this |

---

## 4. What deliberately has no flag

| Feature                                | Why                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Map rendering / base tiles             | If tiles are down, the app is down — a flag can't degrade this gracefully                                                                        |
| Auth / account                         | Same; not a feature, a prerequisite                                                                                                              |
| GDPR data export & deletion            | Legal obligation — must never be switchable off                                                                                                  |
| Safety-critical alert _delivery_ infra | `crash_detection` and `hazard_alerts` gate the features; the push/SMS delivery path itself must not have a global off switch separate from those |

---

## 5. Implementation model (target sketch)

_The bullets below are the original design sketch. §6 records where the live
implementation intentionally diverges — the codebase is the authority._

- A single flag registry keyed by flag with a `boolean | limit` (and system-switch) type, per-tier defaults, and an operator override.
- Guard decorator on controllers: `@RequireFeature('gpx_export')` for booleans and a service-level count check for limits — enforcement is server-side; client flags are for UI only (hide/upsell), never security.
- Audit log on override changes: who flipped which switch when — you'll want this the first time `crash_detection` gets disabled at 2 a.m.
- The entitlements payload returns limits (`road_quality_max_zoom`-style) alongside booleans so the map renderer reads one config object.

---

## 6. Implementation status & reconciliation

The live system (shipped in [#1032](https://github.com/Studio81Labs/tarmoto/pull/1032)) already implements the resolution model above with two deliberate deviations from §5's sketch, and currently covers a **subset** of this catalog's vocabulary.

### 6.1 Architecture (authoritative)

- **The registry is code-defined**, not a DB table with JSONB per-tier defaults. `FEATURE_DEFINITIONS` in `packages/shared/src/feature-flags.ts` is the single source of truth (shared by backend, mobile, companion, admin). The database stores **only override state** — `user_features` / `feature_states` (booleans) and `user_limits` / `limit_states` (numbers). This preserves compile-time DTO⇄registry shape guards and the monotone-tier invariant test that a runtime JSONB table can't. Operators change override values, never the vocabulary.
- **Resolution** is the pure `resolveFeature` / `resolveLimit` (min-clamp) precedence in the shared package; the backend `FeatureResolver` only loads state and folds it through. Enforcement guards: `@RequireFeature(key)` (`FeatureGuard`) for booleans; service-level count checks for limits (e.g. `max_active_trips` via `TripsService.assertCanMintOpenTrip`).
- **System switches (§3) are NOT implemented yet** (Phase 2 — see §6.3). The _planned_ design: a **third registry kind** (`kind: "system"`, `default: true`, no tiers), resolving through the existing global `feature_states` table (operator `force_off` kills a switch for everyone) and served on `/config/flags`, reusing the entitlement machinery but grouped separately in the admin console and never riding on the per-user `/users/me` payload. The shipped `FEATURE_DEFINITIONS` currently has only `toggle` and `limit` kinds; no `sys_*` key exists at runtime today.
- **Endpoint naming:** resolved entitlements ride on `GET /users/me` as `features` + `limits` (not a dedicated `GET /me/entitlements`; the `features` field name is retained for contract stability). Global override maps: `GET /api/v1/config/flags` and `GET /api/v1/config/limits`.
- **Operator settings precedent:** the generic `app_settings` key/value store (backs `launch_tier` today) is the sibling operator-config pattern; system switches stay in `feature_states` rather than `app_settings` so they share the entitlement kill-switch tooling and audit log.

### 6.2 What ships today

**Phase 1 (this branch) — all §1 flags + §2 limits are in the registry:**

- **Flags (22):** the full §1 vocabulary — 11 Free, 6 Pro, 5 Premium. `full_road_quality_zoom` renamed to `road_quality_full_zoom`; `unlimited_trip_planning` retired (superseded by the `max_active_trips` limit).
- **Limits (6):** the full §2 set. Only `max_active_trips` (Free = 1) is **enforced** today — across every trip mint + completed→open promotion path. The other five are defined vocabulary with no enforcement yet.
- Migration `1814-AlignFeatureFlagCatalog` renames the launch-mode override row for the renamed flag and drops the retired flag's rows. The newly-added flags/limits carry **no override rows and no launch seed** — they are inert registry vocabulary until a feature is wired to them.
- Existing launch-mode dark-ship posture is unchanged (`max_active_trips = NULL`; several Pro/Premium flags seeded `force_on`) until monetization goes live. Clients still do not consume the snapshot for gating — that remains the next workstream.

### 6.3 Remaining to reach this catalog

- **System switches (§3):** the `kind: "system"` mechanism + the 14 `sys_*` switches — a separate follow-up (Phase 2).
- **Per-feature enforcement:** defining a flag does not gate a feature until a guard/limit check is wired. Most §1 flags gate features that are currently ungated (e.g. `crash_detection`, `carplay_android_auto`); wiring each is a per-feature follow-up. Among limits, only `max_active_trips` is enforced.
- **Client consumption:** UI gating/upsell reading the `features`/`limits` snapshot (+ the `/config/*` kill-switch fast path).
- **Marketing / `PLAN_CATALOG` copy** and any launch-mode seeding decisions land with the enforcement PR for the relevant capability.

---

_End of document_
