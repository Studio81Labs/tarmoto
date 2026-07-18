# System-Switch Enforcement — Cluster 2 (Community & Social) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire backend enforcement for the three community & social kill switches — `sys_ride_publishing`, `sys_community_collections`, `sys_poi_ratings` — so flipping one stops/degrades its subsystem.

**Architecture:** Reuse the existing `FeatureResolver.isSystemSwitchEnabled(key)` (on unless `force_off`, uncached, immediate kills), read at each subsystem's natural point. Reads degrade to empty/zeroed (never throw); writes to a killed feature return a clean 503; the `is_public→true` publish direction is coerced to private. Five modules gain the `FeaturesModule` import. No contract change. Spec: `docs/superpowers/specs/2026-07-18-system-switch-enforcement-cluster2-design.md`.

**Tech Stack:** NestJS 11 + TypeORM, TypeScript strict, jest (`--testPathPatterns`).

## Global Constraints

- Enforcement is service-level. **Reads degrade to empty/neutral, never throw. Writes to a killed feature throw a clean `ServiceUnavailableException` (503).** `delete`/withdraw/unpublish paths always stay allowed.
- **`sys_ride_publishing` is DIRECTIONAL**: block only the `is_public → true` direction (coerce to private); `is_public=false` (unpublish) and all reads stay live. Two write paths: `SharingService.toggleShare` AND `RidesService.applyDefaultRideSharing`.
- **`sys_community_collections` gates the browse feed only** (`listDiscover`) — NOT `getBySlug`/preview (direct links) and NOT the personal library (`listMine`/`listLibrary`).
- **`sys_poi_ratings` spans two services**: `ReviewsService` (reads→[], writes→503) AND `RoadsService.findById` (zero the embedded `review_count`/`avg_review_rating`/`recent_reviews`). Both required — missing the roads embed leaks ratings onto the road page (the #1038 trap).
- **Test rule (from #1038):** every gated method's off-case test asserts `isSystemSwitchEnabled` was called `toHaveBeenCalledWith('<the exact key>')`, so a key-swap between methods can't pass all tests silently.
- Each consuming module adds `FeaturesModule` (`apps/backend/src/modules/features/features.module.ts`) to `imports` — it is not `@Global`. No circular dep. Existing suites stay green: each new `FeatureResolver` stub defaults `isSystemSwitchEnabled` → `true`.
- Switch keys exact: `sys_ride_publishing`, `sys_community_collections`, `sys_poi_ratings` (from `@tarmoto/shared`). No contract change (`openapi:gen` zero drift). Backend `.js` ESM imports, single quotes, jest. Repo green after every commit. Conventional commits, lowercase, scope `backend`. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `sys_ride_publishing` — block making rides public (two write paths)

**Files:**

- Modify: `apps/backend/src/modules/sharing/sharing.service.ts` (`toggleShare` ~line 53) + `sharing.module.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.ts` (`applyDefaultRideSharing` ~line 164; `rides.module.ts` already imports `FeaturesModule` — inject only)
- Modify: `apps/backend/src/modules/sharing/sharing.service.spec.ts`, `apps/backend/src/modules/rides/rides.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.isSystemSwitchEnabled` (shipped in #1038), `FeaturesModule`.

- [ ] **Step 1: Write the failing tests.** In `sharing.service.spec.ts`, add a `FeatureResolver` stub (default `isSystemSwitchEnabled` → `true`), then:

```ts
it("coerces a publish to private when sys_ride_publishing is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result = await service.toggleShare(USER_ID, RIDE_ID, true); // request public
  expect(result.is_public).toBe(false); // coerced private, no throw
  expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
    "sys_ride_publishing",
  );
});

it("still allows unpublishing when sys_ride_publishing is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result = await service.toggleShare(USER_ID, RIDE_ID, false);
  expect(result.is_public).toBe(false); // unpublish works
});
```

Reuse the file's existing `toggleShare` happy-test setup (ride/user mocks, the real repo handles). In `rides.service.spec.ts`, add the stub + an off-case for `applyDefaultRideSharing` — since it's private, exercise it via the public path that calls it (`stop()`) OR (if the spec already tests it directly) assert that when off, no `SharedRide` is saved:

```ts
it("skips default auto-publish when sys_ride_publishing is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  // drive the stop()/auto-publish path the existing happy test uses
  // assert the sharedRide repo save was NOT called + key asserted
  expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
    "sys_ride_publishing",
  );
});
```

Read the existing rides spec first to reuse its real handles and the exact path that triggers `applyDefaultRideSharing`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns 'sharing.service|rides.service'`
Expected: FAIL (stub not provided / not coercing).

- [ ] **Step 3: Implement.**
  - `sharing.service.ts`: import + inject `FeatureResolver`. At the top of `toggleShare`, after the ride-ownership lookup, coerce:

```ts
// sys_ride_publishing is directional: block only the publish direction.
// Unpublishing (isPublic=false) always works so a kill can't trap a
// ride as public.
const effectiveIsPublic =
  isPublic &&
  (await this.featureResolver.isSystemSwitchEnabled("sys_ride_publishing"));
```

Then use `effectiveIsPublic` everywhere the method currently uses `isPublic` for the create/update of the `SharedRide` row (read the method; replace the persisted value). Return shape is unchanged (`SharedRideResponseDto` with `is_public: effectiveIsPublic`).

- `rides.service.ts`: import + inject `FeatureResolver`. First statement of `applyDefaultRideSharing`:

```ts
if (
  !(await this.featureResolver.isSystemSwitchEnabled("sys_ride_publishing"))
) {
  return; // auto-publish disabled — leave the ride private
}
```

- `sharing.module.ts`: add `FeaturesModule` to `imports` + the `.js` import. (`rides.module.ts` already imports it — no change.)

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns 'sharing.service|rides.service' && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/sharing/ apps/backend/src/modules/rides/
git commit -m "feat(backend): gate ride publishing behind sys_ride_publishing (coerce publish to private)"
```

---

### Task 2: `sys_community_collections` — hide the browse feed

**Files:**

- Modify: `apps/backend/src/modules/route-collections/route-collections.service.ts` (`listDiscover` ~line 98) + `route-collections.module.ts`
- Modify: `apps/backend/src/modules/route-collections/route-collections.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.isSystemSwitchEnabled`, `FeaturesModule`.

- [ ] **Step 1: Write the failing tests.** Add a `FeatureResolver` stub (default `true`), then:

```ts
it("listDiscover returns an empty page when sys_community_collections is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result = await service.listDiscover(VIEWER_ID, undefined, 12, 0);
  expect(result).toEqual({ items: [], total: 0, limit: 12, offset: 0 });
  expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
    "sys_community_collections",
  );
  // scope guard: the discover query was NOT run
  expect(repo.createQueryBuilder).not.toHaveBeenCalled(); // use the real builder handle
});

it("does NOT gate the personal library (listMine) on sys_community_collections", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  await service.listMine(USER_ID); // should not consult the switch / should still query
  // assert listMine ran its query normally; adapt to the spec's real handles
});
```

Reuse the file's real query-builder handle + `listDiscover` happy-test args. `listDiscover` returns `{ items, total, limit, offset }` (confirm the exact field names at line 190).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns route-collections`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `route-collections.service.ts`: import + inject `FeatureResolver`. First statement of `listDiscover(viewerId, q, limit = 12, offset = 0)`:

```ts
if (
  !(await this.featureResolver.isSystemSwitchEnabled(
    "sys_community_collections",
  ))
) {
  return { items: [], total: 0, limit, offset };
}
```

Do NOT touch `listMine`/`listLibrary`/`getBySlug`/`getPreviewBySlug`/CRUD. In `route-collections.module.ts`, add `FeaturesModule` to `imports` + the import.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns route-collections && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/route-collections/
git commit -m "feat(backend): gate community collections browse behind sys_community_collections"
```

---

### Task 3: `sys_poi_ratings` — reviews service (reads hidden, writes 503)

**Files:**

- Modify: `apps/backend/src/modules/reviews/reviews.service.ts` (`listForSegment` ~200, `create` ~249, `update` ~328, `uploadPhotos` ~443, `castVote` ~589, `clearVote` ~629; leave `delete` ~385 alone) + `reviews.module.ts`
- Modify: `apps/backend/src/modules/reviews/reviews.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.isSystemSwitchEnabled`, `FeaturesModule`, `ServiceUnavailableException` from `@nestjs/common`.

- [ ] **Step 1: Write the failing tests.** Add a `FeatureResolver` stub (default `true`), then:

```ts
it("listForSegment returns [] without querying when sys_poi_ratings is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result = await service.listForSegment(SEGMENT_ID, USER_ID);
  expect(result).toEqual([]);
  expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
    "sys_poi_ratings",
  );
  expect(repo.find).not.toHaveBeenCalled(); // real handle
});

it("create throws 503 when sys_poi_ratings is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  await expect(
    service.create(USER_ID, SEGMENT_ID, CREATE_DTO),
  ).rejects.toBeInstanceOf(ServiceUnavailableException);
});

it("castVote throws 503 when sys_poi_ratings is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  await expect(service.castVote(/* real args */)).rejects.toBeInstanceOf(
    ServiceUnavailableException,
  );
});

it("delete still works when sys_poi_ratings is off (withdrawal always allowed)", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  await expect(service.delete(USER_ID, SEGMENT_ID)).resolves.not.toThrow();
});
```

Read the existing reviews spec for the real method args (`create`/`castVote` signatures) + the real repo mock handle for `listForSegment`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns reviews`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `reviews.service.ts`: import + inject `FeatureResolver`; add `ServiceUnavailableException` to the `@nestjs/common` import.
  - `listForSegment(...)` first statement:

```ts
if (!(await this.featureResolver.isSystemSwitchEnabled("sys_poi_ratings"))) {
  return [];
}
```

- `create`, `update`, `uploadPhotos`, `castVote`, `clearVote` — first statement of each:

```ts
if (!(await this.featureResolver.isSystemSwitchEnabled("sys_poi_ratings"))) {
  throw new ServiceUnavailableException("Reviews are temporarily unavailable");
}
```

- Do NOT gate `delete` (withdrawal stays allowed). In `reviews.module.ts`, add `FeaturesModule` to `imports` + the import.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns reviews && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/reviews/
git commit -m "feat(backend): gate road reviews behind sys_poi_ratings (reads hidden, writes 503)"
```

---

### Task 4: `sys_poi_ratings` — zero the road-detail review embed (the leak-fix)

**Files:**

- Modify: `apps/backend/src/modules/roads/roads.service.ts` (`findById` ~355; review aggregate assembled at ~633-635) + `roads.module.ts`
- Modify: `apps/backend/src/modules/roads/roads.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.isSystemSwitchEnabled`, `FeaturesModule`.

- [ ] **Step 1: Write the failing test.** Add a `FeatureResolver` stub (default `true`), then:

```ts
it("findById zeroes the embedded review aggregate when sys_poi_ratings is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result = await service.findById(SEGMENT_ID); // segment exists
  expect(result.review_count).toBe(0);
  expect(result.avg_review_rating).toBeNull();
  expect(result.recent_reviews).toEqual([]);
  expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
    "sys_poi_ratings",
  );
  // the rest of the segment DTO is still populated (only the review block is zeroed)
  expect(result.id).toBe(SEGMENT_ID);
});
```

Read the existing `findById` happy test to reuse its segment/review mock setup + confirm the real DTO field names (`review_count`, `avg_review_rating`, `recent_reviews`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns roads.service`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `roads.service.ts`: import + inject `FeatureResolver`. In `findById`, gate the review sub-query so that when `sys_poi_ratings` is off, the review data is empty. Read the method's actual structure (the review query producing `reviewRows`/`reviewStats` used at lines ~633-635); when off, skip that query and use empty values so the assembly yields `recent_reviews: []`, `review_count: 0`, `avg_review_rating: null`. Concretely, resolve the switch once and guard the review query, e.g.:

```ts
const ratingsEnabled =
  await this.featureResolver.isSystemSwitchEnabled("sys_poi_ratings");
// ...where the review query runs:
const reviewRows = ratingsEnabled
  ? await /* existing recent-reviews query */
  : [];
const reviewStats = ratingsEnabled
  ? await /* existing count/avg query */
  : null;
```

so the existing assembly at ~633-635 (`recent_reviews: mapReviewRows(reviewRows)`, `review_count: reviewStats?.count ?? 0`, `avg_review_rating: reviewStats?.avg_rating ...`) naturally yields the zeroed values. Everything else in the segment DTO is unchanged. In `roads.module.ts`, add `FeaturesModule` to `imports` + the import.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns roads.service && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/roads/
git commit -m "feat(backend): zero road-detail review aggregate when sys_poi_ratings is off"
```

---

### Task 5: Full validation + final review + PR

**Files:** none new — verification only.

- [ ] **Step 1: Full backend suite + build + lint**

Run (each must PASS):

```bash
pnpm --filter @tarmoto/backend test
pnpm backend:build
pnpm backend:lint
```

Expected: backend suite green; build clean; lint 0 errors (10 pre-existing warnings in untouched `events.gateway.ts` are fine).

- [ ] **Step 2: No-contract-change check**

```bash
pnpm openapi:gen >/dev/null 2>&1 && git diff --stat packages/openapi-client/src/generated/schema.d.ts
git checkout -- packages/openapi/postman/ packages/openapi-client/src/generated/schema.d.ts 2>/dev/null
```

Expected: **no change** to `schema.d.ts` (the 503 is a runtime behavior, not a schema change). If it drifts, a response type changed — investigate.

- [ ] **Step 3: Spec conformance sweep** — re-read the spec §3 and confirm: ride_publishing is directional (off+public→private; off+unpublish still works; both `toggleShare` and `applyDefaultRideSharing` gated); collections gates only `listDiscover` (personal library + by-slug untouched); poi_ratings reads→[] AND the roads embed zeroed AND writes→503 AND `delete` allowed; every gated method's off-case test has `toHaveBeenCalledWith('<key>')`; no throw on any read path; no contract drift.

- [ ] **Step 4: Diff review** — `git diff origin/main...HEAD` for debug leftovers, `.js` suffixes on new imports, each module's `FeaturesModule` import, no accidental gating of `delete`/`unshare`/`listMine`/`getBySlug`/`getCurrentWeather`-style safe paths.

- [ ] **Step 5: Push + PR** — push `feat/system-switch-enforcement-2`, open a PR against `main` (title `feat(backend): enforce community & social system switches (publishing/collections/reviews)`), body covering: the three switches + their points, the directional publish gate, the read/write degradation split (empty vs 503), the roads-embed leak-fix, no-contract-change, and test evidence. Label `backend`.

---

## Execution notes

- Tasks 1-4 are independent (different modules); each depends only on the shipped `isSystemSwitchEnabled`. Tasks 3 + 4 both enforce `sys_poi_ratings` — the branch enforces both before the PR (Task 4 is the leak-fix that Task 3 alone would miss).
- The acceptance criteria: reads degrade to empty (never throw), writes 503, publish coerces to private, `delete`/unpublish/personal-library/by-slug stay live, and the roads embed is zeroed. A gated read that throws, a write that fake-succeeds, or a missed `applyDefaultRideSharing`/roads-embed is a defect.
- After any main-merge during execution, `pnpm shared:build` before trusting local eslint.
