# System-Switch Enforcement — Cluster 1 (Third-Party Sources) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make four operator kill switches actually stop their subsystems — `sys_weather_provider`, `sys_nap_conditions`, `sys_nap_routing_avoidance`, `sys_mapillary_previews` — via graceful degradation (return empty/neutral, never throw).

**Architecture:** One resolver helper `FeatureResolver.isSystemSwitchEnabled(key)` (on unless `force_off`, one indexed read, no cache). Each subsystem service reads it at its natural point and returns its empty/neutral shape when off. Three consuming modules (weather, closures, mapillary) add `FeaturesModule` to their imports and inject `FeatureResolver`. No contract change, no new endpoint, no throw.

**Tech Stack:** NestJS 11 + TypeORM, TypeScript strict, jest (`--testPathPatterns`). Spec: `docs/superpowers/specs/2026-07-18-system-switch-enforcement-cluster1-design.md`.

## Global Constraints

- Enforcement is **graceful degradation, NOT a 403** — every gated point returns its empty/neutral shape when the switch is off; never throw (except `ClosuresService.getById`, whose "hidden" shape is the existing `NotFoundException`).
- **No contract change** — no DTO/endpoint changes; responses keep their existing shapes (just empty when off). No OpenAPI regen needed.
- **Safety carve-out:** do NOT gate `WeatherService.getCurrentWeather` (shared with the safety weather-alert sweep + commute). Only `getRouteWeather` is the `sys_weather_provider` point.
- `sys_nap_conditions` (display) and `sys_nap_routing_avoidance` (routing) are **independent** — separate gated methods in the same service.
- Switch keys are exact: `sys_weather_provider`, `sys_nap_conditions`, `sys_nap_routing_avoidance`, `sys_mapillary_previews` (from `@tarmoto/shared` `SystemFeatureKey`).
- Each consuming module adds `FeaturesModule` (`apps/backend/src/modules/features/features.module.ts`) to its `imports` — it is not `@Global`. No circular dependency (FeaturesModule imports none of these).
- Existing weather/closures/mapillary test suites must stay green: their new `FeatureResolver` stub defaults `isSystemSwitchEnabled` → `true` so on-behavior is unchanged.
- Backend: `.js` ESM imports, single quotes, jest. Repo green after every task's commit. Conventional commits, lowercase subjects, scope `backend`. Commit-body trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Run `pnpm backend:lint` locally.

---

### Task 1: Resolver helper — `isSystemSwitchEnabled`

**Files:**

- Modify: `apps/backend/src/modules/features/feature-resolver.service.ts`
- Modify: `apps/backend/src/modules/features/feature-resolver.service.spec.ts`

**Interfaces:**

- Consumes: existing `getGlobalStates()` on the resolver; shared `resolveSystemSwitch`, `type SystemFeatureKey`.
- Produces: `FeatureResolver.isSystemSwitchEnabled(key: SystemFeatureKey): Promise<boolean>` — used by Tasks 2-4.

- [ ] **Step 1: Write the failing test.** In `feature-resolver.service.spec.ts` (it mocks the repositories; there is already a `getSystemSwitches` test seeding `featureStates.find`), add:

```ts
it("isSystemSwitchEnabled is true by default and false only on force_off", async () => {
  featureStates.find.mockResolvedValue([
    { feature: "sys_weather_provider", state: "force_off" },
  ]);
  expect(await resolver.isSystemSwitchEnabled("sys_weather_provider")).toBe(
    false,
  );
  expect(await resolver.isSystemSwitchEnabled("sys_mapillary_previews")).toBe(
    true,
  );
});
```

(Use the same `featureStates` mock handle + `resolver` instance the existing `getSystemSwitches` test uses.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns feature-resolver`
Expected: FAIL — `isSystemSwitchEnabled` is not a function.

- [ ] **Step 3: Implement.** Add `resolveSystemSwitch` + `type SystemFeatureKey` to the existing `@tarmoto/shared` import block (merge, don't duplicate — `buildSystemSwitchSnapshot` is already imported). Add the method near `getSystemSwitches`:

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

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns feature-resolver && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/features/
git commit -m "feat(backend): FeatureResolver.isSystemSwitchEnabled single-switch helper"
```

---

### Task 2: Gate `sys_mapillary_previews` (MapillaryService)

**Files:**

- Modify: `apps/backend/src/modules/mapillary/mapillary.service.ts`
- Modify: `apps/backend/src/modules/mapillary/mapillary.module.ts`
- Modify: `apps/backend/src/modules/mapillary/mapillary.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.isSystemSwitchEnabled` (Task 1), `FeaturesModule`.
- Produces: nothing downstream (leaf enforcement).

- [ ] **Step 1: Write the failing tests.** In `mapillary.service.spec.ts`, add a `FeatureResolver` stub to the providers with `isSystemSwitchEnabled: jest.fn().mockResolvedValue(true)` (default enabled — keeps existing tests green), then add off-case tests:

```ts
it("segmentImagery returns NO_IMAGERY without calling the provider when sys_mapillary_previews is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result =
    await service.segmentImagery(
      /* the same args the existing happy test uses */
    );
  expect(result).toEqual({
    imageId: null,
    capturedAt: null,
    attribution: null,
    link: null,
  });
  expect(httpGetMock).not.toHaveBeenCalled(); // the provider fetch (use whatever the existing spec mocks for the outbound call)
});

it("thumbnail returns null without fetching when sys_mapillary_previews is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  expect(await service.thumbnail("img-1")).toBeNull();
});
```

Read the existing `mapillary.service.spec.ts` first: reuse its exact `segmentImagery` args and the exact mock handle for the outbound HTTP/provider call (named `httpGetMock` above as a placeholder — use the real one). Assert the outbound call is NOT made in the off case.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns mapillary`
Expected: FAIL — `featureResolver` not provided / off-case not short-circuiting.

- [ ] **Step 3: Implement.** In `mapillary.service.ts`:
  - Add the import: `import { FeatureResolver } from '../features/feature-resolver.service.js';`
  - Inject it in the constructor (add `private readonly featureResolver: FeatureResolver,`).
  - At the top of `segmentImagery(...)` (before any provider call):

```ts
if (
  !(await this.featureResolver.isSystemSwitchEnabled("sys_mapillary_previews"))
) {
  return NO_IMAGERY;
}
```

- At the top of `thumbnail(imageId)`:

```ts
if (
  !(await this.featureResolver.isSystemSwitchEnabled("sys_mapillary_previews"))
) {
  return null;
}
```

In `mapillary.module.ts`, add `FeaturesModule` to `imports`: change `imports: [ConfigModule]` → `imports: [ConfigModule, FeaturesModule]` and add `import { FeaturesModule } from '../features/features.module.js';`.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns mapillary && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/mapillary/
git commit -m "feat(backend): gate Mapillary previews behind sys_mapillary_previews"
```

---

### Task 3: Gate `sys_weather_provider` (WeatherService.getRouteWeather)

**Files:**

- Modify: `apps/backend/src/modules/weather/weather.service.ts`
- Modify: `apps/backend/src/modules/weather/weather.module.ts`
- Modify: `apps/backend/src/modules/weather/weather.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.isSystemSwitchEnabled` (Task 1), `FeaturesModule`.

- [ ] **Step 1: Write the failing test.** In `weather.service.spec.ts`, add a `FeatureResolver` stub (`isSystemSwitchEnabled: jest.fn().mockResolvedValue(true)`), then:

```ts
it("getRouteWeather returns an empty result without hitting the provider when sys_weather_provider is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result = await service.getRouteWeather([
    { lat: 46.47, lng: 10.37 },
    { lat: 46.5, lng: 10.41 },
  ]);
  expect(result).toEqual({
    points: [],
    has_alerts: false,
    alerts: [],
    typed_alerts: [],
  });
  expect(providerGetCurrentWeatherMock).not.toHaveBeenCalled(); // use the real provider mock handle
});
```

(Read the existing spec: reuse its provider mock handle; assert the provider is NOT called in the off case. NOTE: do NOT add any `getCurrentWeather` gating test — `getCurrentWeather` stays ungated by design.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns weather`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `weather.service.ts`:
  - Import + inject `FeatureResolver` (as in Task 2).
  - At the very top of `getRouteWeather(route)` (before `sampleRoute`):

```ts
if (
  !(await this.featureResolver.isSystemSwitchEnabled("sys_weather_provider"))
) {
  return { points: [], has_alerts: false, alerts: [], typed_alerts: [] };
}
```

Do NOT touch `getCurrentWeather`. In `weather.module.ts`, add `FeaturesModule` to `imports` (`[ConfigModule, FeaturesModule]`) + the import line.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns weather && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/weather/
git commit -m "feat(backend): gate route weather behind sys_weather_provider (safety sweep untouched)"
```

---

### Task 4: Gate `sys_nap_conditions` + `sys_nap_routing_avoidance` (ClosuresService)

**Files:**

- Modify: `apps/backend/src/modules/closures/closures.service.ts`
- Modify: `apps/backend/src/modules/closures/closures.module.ts`
- Modify: `apps/backend/src/modules/closures/closures.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.isSystemSwitchEnabled` (Task 1), `FeaturesModule`.

- [ ] **Step 1: Write the failing tests.** In `closures.service.spec.ts`, add a `FeatureResolver` stub (`isSystemSwitchEnabled: jest.fn().mockResolvedValue(true)`), then add off-case tests for BOTH switches. `list` returns `RoadClosureDto[]`, `checkRoute` returns `{ closures, full_count, partial_count, advisory_count }`, `getById` returns `RoadClosureDto` (throws `NotFoundException` when absent), `exclusionPolygons` returns the polygon array:

```ts
it("list returns [] without querying when sys_nap_conditions is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false); // for sys_nap_conditions
  const result = await service.list({} as ListClosuresQueryDto);
  expect(result).toEqual([]);
  expect(repo.find).not.toHaveBeenCalled(); // use the real repo mock handle for the list query
});

it("checkRoute returns zeroed counts without querying when sys_nap_conditions is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result =
    await service.checkRoute(/* the same args the existing happy test uses */);
  expect(result).toEqual({
    closures: [],
    full_count: 0,
    partial_count: 0,
    advisory_count: 0,
  });
});

it("getById 404s when sys_nap_conditions is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  await expect(service.getById("c-1")).rejects.toBeInstanceOf(
    NotFoundException,
  );
});

it("exclusionPolygons returns [] without querying when sys_nap_routing_avoidance is off", async () => {
  featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
  const result =
    await service.exclusionPolygons(
      /* the same args the existing happy test / callers use */
    );
  expect(result).toEqual([]);
});
```

Read `closures.service.spec.ts` first: reuse the existing happy-path args for `checkRoute`/`exclusionPolygons` and the real repo mock handle. Confirm the exact `checkRoute` return shape from `closures.service.ts:144` and the exact `RoadClosureDto`/count field names — match them in the assertions. Since all four tests set `isSystemSwitchEnabled` to a blanket `false`, each test exercises exactly one method, so the single stub value is unambiguous per test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns closures`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `closures.service.ts`:
  - Import + inject `FeatureResolver`.
  - `list(query)` first statement:

```ts
if (!(await this.featureResolver.isSystemSwitchEnabled("sys_nap_conditions"))) {
  return [];
}
```

- `checkRoute(...)` first statement:

```ts
if (!(await this.featureResolver.isSystemSwitchEnabled("sys_nap_conditions"))) {
  return { closures: [], full_count: 0, partial_count: 0, advisory_count: 0 };
}
```

(match the exact field names of the `checkRoute` return object at line 144.)

- `getById(id)` first statement:

```ts
if (!(await this.featureResolver.isSystemSwitchEnabled("sys_nap_conditions"))) {
  throw new NotFoundException(
    /* same message/shape the existing not-found path uses */
  );
}
```

- `exclusionPolygons(...)` first statement:

```ts
if (
  !(await this.featureResolver.isSystemSwitchEnabled(
    "sys_nap_routing_avoidance",
  ))
) {
  return [];
}
```

In `closures.module.ts`, add `FeaturesModule` to `imports` (`[TypeOrmModule.forFeature([RoadClosure]), FeaturesModule]`) + the import line.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns closures && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/closures/
git commit -m "feat(backend): gate NAP closure display + routing avoidance behind their system switches"
```

---

### Task 5: Full-repo validation + PR

**Files:** none new — verification only.

- [ ] **Step 1: Full backend suite + build + lint**

Run (each must PASS):

```bash
pnpm --filter @tarmoto/backend test
pnpm backend:build
pnpm backend:lint
```

Expected: backend suite green (the new off-case tests pass, all existing on-behavior tests unchanged); build clean; lint 0 errors (10 pre-existing warnings in untouched `events.gateway.ts` are fine).

- [ ] **Step 2: No-contract-change check** — confirm no OpenAPI regen is needed:

```bash
pnpm openapi:gen >/dev/null 2>&1 && git diff --stat packages/openapi-client/src/generated/schema.d.ts
```

Expected: **no change** to `schema.d.ts` (this PR adds no endpoint/DTO). If it shows drift, something changed a response type — investigate. Then `git checkout -- packages/openapi/postman/ packages/openapi-client/src/generated/schema.d.ts` to drop any generator/format churn.

- [ ] **Step 3: Spec conformance sweep** — re-read `docs/superpowers/specs/2026-07-18-system-switch-enforcement-cluster1-design.md` §3 and confirm: the helper exists; all four points gated with the exact degraded shapes; `getCurrentWeather` NOT gated (grep `getCurrentWeather` in weather.service.ts — no `isSystemSwitchEnabled` around it); the two NAP switches are independent (distinct keys at distinct methods); no `throw` added except `getById`'s existing NotFound; no contract change.

- [ ] **Step 4: Diff review** — `git diff origin/main...HEAD` for debug leftovers, `.js` import suffixes on the new imports, no accidental change to `getCurrentWeather` or entitlement paths, each module's `FeaturesModule` import present.

- [ ] **Step 5: Push + PR** — push `feat/system-switch-enforcement`, open a PR against `main` (title `feat(cross): enforce third-party-source system switches (weather/NAP/Mapillary)`), body covering: the helper + the four gated points + graceful-degradation (no throw), the weather safety carve-out, no-contract-change, and test evidence. Label `cross` (or `backend`).

---

## Execution notes

- Tasks 2-4 are independent of each other (different modules); each depends only on Task 1's helper.
- The degradation shapes are the acceptance criteria — a gated point that throws (instead of returning empty) or that still hits the provider/repo when off is a defect.
- `getCurrentWeather` must stay ungated — it is the single most important carve-out (safety weather-alert sweep). Any test or code that gates it is wrong.
- After any main-merge during execution, `pnpm shared:build` before trusting local eslint.
