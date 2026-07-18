# System-Switch Enforcement — Ingest, Gamification & Notifications Cluster (Phase 3, PR 3) — Design

- **Date:** 2026-07-18
- **Status:** Approved (design); pending implementation plan
- **Builds on:** the system-switch mechanism (#1036), enforcement cluster 1 (#1038, third-party sources), and cluster 2 (#1041, community & social). Those established `FeatureResolver.isSystemSwitchEnabled(key)`, the service-level graceful-degradation pattern (reads → empty/zeroed, writes → 503, withdrawal always allowed), the "scope to your own data, not the whole shared surface" lesson, and the reusable `SystemSwitchGuard` + `@RequireSystemSwitch(key)` route guard that rejects with 503 in the guard phase (before body-parsing/validation). Catalog: `docs/feature-flags.md`.
- **Scope:** wire backend enforcement for the three remaining enforceable system switches — `sys_surface_upload`, `sys_gamification`, `sys_push_notifications` — across the sensor, badges, challenges, exploration, users, jobs, and push modules.

## 1. Background & motivation

These are the last of the backend-enforceable operator kill switches. `sys_surface_upload` and `sys_gamification` are clean "kill the feature's own surface" switches. `sys_push_notifications` is the subtle one: it must kill non-critical push during an incident while a **safety denylist** (`hazard_alert`, `weather_alert`, `crash_followup`) always sends — and it does not fit the 503-write pattern because sends are fire-and-forget side effects of unrelated actions.

All three keys already exist in the registry (`packages/shared/src/feature-flags.ts`, `kind: "system"`, `default: true`) with **zero enforcement today** — a clean slate. The operator admin surface (`/admin/system-switches/:key/disable`) already drives all three off `SYSTEM_FEATURE_KEYS`; no admin-side work is needed.

## 2. Decisions (user-confirmed)

1. **All three switches in one PR.**
2. **`sys_gamification` covers Badges + Challenges + Exploration ("personal road map", US-50)** — matching the registry description "Badges, challenges, personal road map (Epic 7)". **Leaderboards stay live** (not gated).
3. **`sys_push_notifications` off suppresses BOTH the device push AND the in-app notification row** for non-safety categories (the whole non-safety notification disappears until restored). The safety denylist always sends. Email/digest is a separate path and is out of scope.

## 3. Design

All reuse `FeatureResolver.isSystemSwitchEnabled(key)` (true unless an operator `force_off`; one indexed read, no cache → immediate kills). Each consuming module adds `FeaturesModule` to its `imports` (not `@Global`) and injects `FeatureResolver` (or, for a route guard, `SystemSwitchGuard` from `../features/system-switch.guard.js` + `@RequireSystemSwitch` from `../features/require-system-switch.decorator.js` — these are not re-exported by the features barrel, import them directly). ESM `.js` import suffixes throughout. **Testing rule (from #1038):** every gated method's off-case test asserts `isSystemSwitchEnabled` was `toHaveBeenCalledWith('<the exact key>')`.

### 3.1 `sys_surface_upload` — block sensor ingest (one write)

`SensorController.upload` (`@Post('upload')`, `sensor.controller.ts`) accepts a JSON batch of up to 5000 sensor readings (`UploadSensorDataDto`, not multipart) and `SensorService.processUpload` persists `surface_readings` / `ride_stats` / ride calibration. Single write point; no read-side depends on it (downstream display reads aggregated `road_segments.quality_score`, gated by the unrelated `road_quality_overlay` toggle).

- **Route guard:** `@UseGuards(SystemSwitchGuard, AuthGuard)` + `@RequireSystemSwitch('sys_surface_upload')` on `upload`, guard ordered first. Guards run before pipes, so when off it 503s **before** the `ValidationPipe` validates the up-to-5000-item array — that is the load it sheds (there is no Multer here, so the "before Multer buffers" rationale from the reviews-photo route does not apply verbatim; the benefit is skipping nested validation + the DB-write pipeline).
- **Service gate:** `SensorService.processUpload` also throws `ServiceUnavailableException('Sensor upload is temporarily unavailable')` as its first statement — the authoritative guarantee + defense-in-depth (same guard-plus-service shape as cluster-2 `uploadPhotos`).
- **Distinct from the privacy opt-out:** `processUpload` already early-returns 202 with `{accepted: 0, segments_updated: 0}` when `prefs.road_data_contribution` is off. That path is unchanged; the operator kill is a 503, placed before it. The two must stay clearly distinguished (503 kill vs 202 privacy-degrade).
- **Module:** `sensor.module` adds `FeaturesModule`.

### 3.2 `sys_gamification` — hide badges, challenges, and the personal road map

`FeaturesModule` added to `badges`, `challenges`, `exploration` modules; `users.module` already imports it; the jobs module wires `FeatureResolver` into the recheck processor.

**Badges** (`badges.service.ts`):

- **Reads → empty/neutral:** `listBadges(userId)` (`GET users/:userId/badges`) → `[]`; `computeProgression(userId)` (`GET users/me/progression`) → a neutral/empty progression (match the DTO's shape — zeroed counts, empty tier list).
- **Write → 503:** `checkAndAward(userId)` (`POST badges/check`) → `ServiceUnavailableException`.
- **Background job → skip:** `badges-recheck.processor.ts` `dispatch()` early-returns when off (skips the nightly 36h-window sweep, so it does no work and does not spam per-user 503s from `checkAndAward`). The processor injects `FeatureResolver`.
- **Cross-surface leak-fix:** `UsersService.getMeProfile(userId)` (`GET users/me/profile`) embeds `badges_earned` (a `userBadgeRepo.count()` + `computeStats`). When off, zero **only** `badges_earned`; the other `MeProfileDto` fields (`total_hours`, `total_rides`, `total_distance_km`, `roads_discovered`, `hazards_reported`) are generic ride stats and stay populated. This is the cluster-2 roads-embed leak pattern: a gamification value must not survive on a shared profile endpoint after the feature is killed.

**Challenges** (`challenges.service.ts`):

- **Reads:** `listActive()` (`GET challenges`) → `[]`; `getDetail(challengeId, userId)` (`GET challenges/:challengeId`, includes its leaderboard) → **404** `NotFoundException` ("challenge not available"); `getProgress(userId, challengeId)` (`GET challenges/:challengeId/progress`) → **404**. A 404 on a killed single-resource GET is the accepted degrade established in cluster 1 (`closures.getById`) — not a 500, and it hides the resource entirely rather than leaking its metadata via an empty-but-shaped body.
- **Write → 503:** `join(userId, challengeId)` (`POST challenges/:challengeId/join`).
- **Not gated:** `updateProgress` is dead code (no production caller) — noted, not gated.

**Exploration** (`exploration.service.ts`, "personal road map"):

- **All reads → empty/neutral:** `getStats(userId)` (`GET exploration/stats`) → zeroed stats; `getNearbyUnridden(...)` (`GET exploration/nearby-unridden`) → `[]`; `getRiddenIds(userId)` (`GET exploration/ridden-ids`) → `[]`; `getRiddenSegments(userId)` (`GET exploration/ridden-segments`) → `[]`. No writes.

### 3.3 `sys_push_notifications` — kill non-critical push, always send safety alerts

`PushService.sendToUser(userId, input)` (`push.service.ts`) is the single chokepoint that both writes the in-app row (`createInAppNotification`) and calls the provider send; `sendToUsers` fans out to it, so gating `sendToUser` covers everything. The six calling modules (hazards, safety, followers, trip-activity, jobs, account) need no changes.

- **New safety set:** `SAFETY_NOTIFICATION_CATEGORIES` in `@tarmoto/shared` (`notifications.ts`) = `{ hazard_alert, weather_alert, crash_followup }`. **Deliberately separate** from the existing `CRITICAL_NOTIFICATION_CATEGORIES` (`{ crash_followup }`, which only bypasses quiet-hours) — reusing that set would silently drop hazard/weather alerts.
- **Gate placement:** at the very top of `sendToUser`, after the notification's `category` is known: if the category is **not** in `SAFETY_NOTIFICATION_CATEGORIES` **and** `isSystemSwitchEnabled('sys_push_notifications')` is false → return a zeroed `PushDispatchResult` with a new `suppressedReason: 'system-switch-off'`, writing **neither** the in-app row **nor** the provider push. Safety categories skip the check entirely and proceed through the existing preference/quiet-hours/send logic unchanged.
- **No 503, no route guard.** The class contract is that sends are best-effort and callers must not propagate failures into user-facing responses (e.g. `safety.service` does `void this.pushService.sendToUser(...).catch(...)`); throwing would break the unrelated primary action (hazard-report submission, a follow) when an operator kills push. So this is a silent suppress (read-degrade shaped), not a write-503, and `SystemSwitchGuard` does not apply (there is no HTTP route to guard).
- **Module:** `push.module` adds `FeaturesModule`; `PushService` injects `FeatureResolver`.

### 3.4 Testing

- **Per gated method:** off ⇒ the degraded shape (503 / empty / 404 / neutral / suppressed) and the provider/repo write is not performed; on/absent ⇒ existing behavior unchanged. Each off-case asserts `toHaveBeenCalledWith('<key>')`.
- **Surface upload:** guard + service both reject; the `SystemSwitchGuard` route wiring is locked via the `__guards__` / `REQUIRED_SYSTEM_SWITCH_KEY` metadata assertions (the cluster-2 idiom) so the pre-validation gate can't regress; on ⇒ upload persists.
- **Gamification:** badges reads empty, `checkAndAward` 503, recheck job skips (asserts `checkAndAward` not called when off), `getMeProfile` zeroes only `badges_earned` while other stats stay (the leak test); challenges list empty / detail+progress 404 / join 503; exploration reads empty.
- **Push (the safety-critical test):** with the switch off, a `hazard_alert` / `weather_alert` / `crash_followup` still writes the in-app row AND calls the provider (safety bypass), while a non-safety category (e.g. `new_follower`) writes neither and returns `suppressedReason: 'system-switch-off'`. On ⇒ all categories send.
- Existing suites stay green — each new `FeatureResolver` stub defaults `isSystemSwitchEnabled` → `true`.

### 3.5 Contract

No DTO/endpoint shape changes — responses keep their shapes (empty/zeroed/404/suppressed at runtime). The new `SAFETY_NOTIFICATION_CATEGORIES` constant and the `suppressedReason: 'system-switch-off'` value are additive; `PushDispatchResult` is an internal type (not a served DTO). `openapi:gen` must show zero drift — confirmed during validation. If a `suppressedReason` union leaks into a served schema, that is a signal to investigate, not accept.

## 4. Out of scope (follow-ups)

- **Leaderboards** (`leaderboards.service.ts`) — stays live per decision 2.
- **Email / weekly digest** — a separate path (`digest-weekly.processor` → `EmailService`), not through `PushService`; unaffected by `sys_push_notifications`.
- **Device-token registration and notification-preference CRUD** — config surfaces, always allowed (analogous to the withdrawal carve-out).
- **Dead paths** — `challenges.updateProgress`, `InAppNotificationsService.create`, the vestigial per-category `email` channel toggle: noted, not gated.
- **Not backend-enforceable / already covered:** `sys_booking_affiliate` (not built), `sys_aerial_basemap` (client-only). After this cluster, the remaining work is **client consumption** of the resolved switch map.
