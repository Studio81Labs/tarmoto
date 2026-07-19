# Testing Strategy

How we test Tarmoto. For CI details see `.github/workflows/`. For running locally see [../../CONTRIBUTING.md#before-opening-a-pr](../../CONTRIBUTING.md#before-opening-a-pr).

## Principles

- **Test behavior people depend on, not implementation.** Prefer tests that fail when a user-visible contract breaks, not when an internal helper changes signature.
- **Prioritize risky areas.** First dibs on tests:
  - `sensor` — road surface classification (ML inference inputs/outputs, fallback behavior)
  - `rides` — ride lifecycle, segment calculation, GPS buffer handling
  - `trips` — multi-day trip planning, waypoint sequencing
  - `hazards` — report dedupe, expiry, spatial uniqueness
  - `safety` — incident detection thresholds, alert fan-out
  - `auth` — JWT lifetime, guards
- **No enforced coverage threshold today.** Use judgment; cover the path a regression would hurt most.

## Backend

### Unit tests

- **Location:** colocated next to source as `*.spec.ts`. Example: `src/modules/rides/rides.service.spec.ts`.
- **Runner:** Jest (NestJS default). Config embedded in `apps/backend/package.json`.
- **Commands:**
  - `pnpm backend:test` — backend unit tests (`pnpm test` at the root runs **every** workspace's tests)
  - `pnpm --filter @tarmoto/backend test:watch` — watch mode
  - `pnpm --filter @tarmoto/backend test:cov` — with coverage
- **What goes here:** pure functions, service methods with mocked dependencies, edge cases for classification / scoring / geospatial logic. Mock `TypeORM` repositories via Jest stubs; mock `WeatherService`, `TileService` at the service boundary.

### End-to-end (E2E) tests

- **Location:** `apps/backend/test/*.e2e-spec.ts` with config in `apps/backend/test/jest-e2e.json`.
- **Command:** `pnpm --filter @tarmoto/backend test:e2e`. Requires a running database — run `pnpm db:up` first.
- **What goes here:** request → response cycles exercising real modules against a real Postgres (test DB). Existing coverage spans admin auth/management, hazards, road-quality, exploration, account-deletion, and demo seeding (`apps/backend/test/*.e2e-spec.ts`). Expand as endpoints solidify.
- **When to add an E2E test:**
  - New public API endpoint
  - Change to auth/JWT behavior
  - Change to a safety-critical data path (ride recording, hazard reporting)
  - WebSocket event contract changes
- **When a unit test is enough:** pure classification/scoring logic, pure data transformations, geospatial helpers.

### Mocking patterns

- **TypeORM repositories:** inject `getRepositoryToken(Entity)` stubs returning hand-crafted data. Don't mock repository methods one-by-one — stub at the service's repository boundary.
- **External services (weather, tile server):** mock at the service class boundary. Do not hit the network in tests.
- **TensorFlow Lite on mobile:** don't try to run the model in tests. Mock `sensorService.classify()` to return a fixed label.

## Mobile (React Native)

### Current state

Jest and `@testing-library/react-native` are configured with tests covering stores, screens, and build assertions. See `apps/mobile/src/__tests__/` and per-feature `__tests__/` directories for the current suite. Continue adding tests as features stabilize.

### Priority surfaces

- `services/location` — GPS tracking, buffering under network loss
- `services/sensor` — ML classification wrapper, fallback when model fails to load
- `stores/rideStore` — ride lifecycle state transitions
- `stores/hazardStore` — pending-report queue, optimistic apply

### Test layout (target)

When adding tests, colocate next to source (`screens/HomeScreen.test.tsx` next to `screens/HomeScreen.tsx`) or use `__tests__/` subfolders per feature — pick one convention and stick to it.

### Command

`pnpm --filter @tarmoto/mobile test` (runs in CI via `mobile-ci.yml`). Native
release-mode preview builds also run for Android and iOS on every mobile PR;
successful runs upload a standalone APK and zipped simulator `.app` for seven
days. See [mobile development and release](./mobile-development-release.md).

## Companion (Next.js web)

### Unit / component tests

- **Runner:** Vitest + `@testing-library/react`. Config in `apps/companion/vitest.config.ts`, jsdom environment.
- **Location:** colocated as `*.test.ts` / `*.test.tsx` next to source. Examples: `src/stores/trip.test.ts`, `src/components/TripCollaborateModal.test.tsx`.
- **Command:** `pnpm --filter @tarmoto/companion test`.
- **What goes here:** pure logic in `lib/`, store reducers, hook behavior, component-level interactions that don't need a real browser.

### End-to-end (E2E) tests — Playwright

- **Runner:** `@playwright/test` against Chromium.
- **Location:** `apps/companion/e2e/tests/*.spec.ts`. Config in `apps/companion/playwright.config.ts`.
- **Command:** `pnpm --filter @tarmoto/companion test:e2e` (one-time setup: `pnpm --filter @tarmoto/companion test:e2e:install`).
- **Local UI mode:** `pnpm --filter @tarmoto/companion test:e2e:ui`.

#### Backend stub

The companion E2E suite drives the real Next.js dev server but proxies the backend through a small in-process Express stub at `apps/companion/e2e/mock-backend/server.ts`. The stub:

- Implements endpoints the suites exercise (auth, trips, account, suggestions, closures, passes, hazards, and more — see `e2e/mock-backend/server.ts` for the full list).
- Holds state in memory and resets per test via the `mockApi` fixture.
- Is hard-wired to never reach Stripe; tests assert on the request payload going to `/account/subscription/{checkout,portal}` instead.

This trade-off keeps CI fast and avoids standing up Postgres / Redis. Full backend integration is covered by the backend's own e2e suite (`apps/backend/test/*.e2e-spec.ts`).

#### Critical flows covered

- **Auth** (`auth.spec.ts`): register → auto-sign-in, login success / failure, forgot-password success screen, cross-page navigation, unauthenticated redirect.
- **Trip planner** (`trip-planner.spec.ts`): demo trip → generate three options → select option → promote-to-server save → reopen via trip detail.
- **Trip collaboration** (`trip-collaboration.spec.ts`): two browser contexts round-tripping a suggestion + vote; public share-link page anonymous load.
- **Road quality explorer** (`road-explorer.spec.ts`): filter checkboxes mirror URL params; reset clears them; URL params hydrate the panel on cold load.
- **Subscription** (`subscription.spec.ts`): upgrade-to-Premium intent reaches Stripe Checkout, portal entry from "Open billing portal" / "Update payment method" / cancel-subscription dialog routes through the right portal flow.
- **Settings** (`settings.spec.ts`): privacy + notification preferences round-trip via PUT, bike CRUD (add / edit / delete), account-deletion confirmation gate (without actually deleting in CI).

Cursor-presence and live WebSocket sync between collaborators are mocked out; the round-trip assertions reload the page to fetch fresh state.

### Priority surfaces

- `lib/api` — API client error handling, token refresh
- `stores/*` — route-planning state, auth
- `proxy.ts` — route protection
- Form validation in `(auth)/` flows

## What gets run in CI

Each PR triggers (path-filtered per app):

- `backend-ci.yml` — builds `shared` + `backend`, runs lint, runs backend unit tests
- `companion-ci.yml` — lint, typecheck, Vitest, and Next.js build for the companion
- `companion-e2e.yml` — runs the Playwright suite against the in-process mock backend; uploads traces and the HTML report on failure
- `admin-ci.yml` — lint, typecheck, Vitest, `node --test` worker tests, and build for the admin console
- `marketing-ci.yml` — build, typecheck, `node --test` worker tests, and a `wrangler` dry-run
- `mobile-ci.yml` — lint, typecheck, Jest, Android release APK, and iOS release simulator build for the mobile app
- `packages-ci.yml` — build/test/typecheck of `packages/*` (Vitest)
- `openapi-check.yml` — OpenAPI freshness gate: regenerates the spec + client (`pnpm openapi:gen`) and fails if the committed `packages/openapi-client` schema is stale
- `poc-ci.yml` — PoC sensor build
- `lint-pr.yml` — enforces conventional-commit PR titles with valid scope

If CI fails, fix the root cause. Do not merge on a red build.

## Adding a new test — quick recipe

### Backend unit test

1. Create `<module>/<thing>.spec.ts` next to the source.
2. Use NestJS `Test.createTestingModule()` to build the graph with stubs.
3. Assert the contract a caller depends on.

### Backend E2E test

1. Create `apps/backend/test/<feature>.e2e-spec.ts`.
2. Bootstrap the app via the existing `app.e2e-spec.ts` pattern.
3. Use `supertest` to hit real endpoints. Seed via a TypeORM repository if needed.
4. Tear down between tests — don't leak state.

### Mobile test (when you start)

1. Create `src/<path>/<Name>.test.tsx`.
2. Use `@testing-library/react-native` — render, assert visible text / semantics.
3. Mock hooks (Zustand stores, services) with factories.
