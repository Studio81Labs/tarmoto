# Mobile Entitlement Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the React Native app (`apps/mobile`) to consume the already-served entitlement snapshot (`subscription_tier`/`features`/`limits`, already in the Zustand auth store) and gate its three surfaces — road-quality overlay zoom, GPX export, trip-join — shipping DARK behind the existing launch-mode seeds.

**Architecture:** Read the snapshot from the Zustand auth store via thin `useEntitlements`/`useFeature`/`useLimit` selector hooks (NO react-query — mobile has none; the snapshot is cached + refreshed by `authBootstrap`). Port the companion `<UpgradePrompt>` to an RN `Modal` with an IAP-ready `onUpgrade` seam (informational for now). Hoist the pure overlay-cap math to `@tarmoto/shared` (parameterized by a platform source ceiling) so companion + mobile share one definition.

**Tech Stack:** React Native, Zustand, `@maplibre/maplibre-react-native`, `@tarmoto/openapi-client` (`openapi-fetch`), `@tarmoto/shared`, typed i18n (`src/i18n`), Jest + React Native Testing Library.

## Global Constraints

- `road_quality_max_zoom`: free = **12**, pro/premium = `null` (unlimited). Fail-closed fallback while unresolved = free cap 12. Unlimited → the platform source ceiling.
- **Mobile source ceiling = `18`** (the backend road-tile vector source's real max, matching companion's `MapCanvas` `maxzoom: 18`; mobile's current `<VectorSource maxzoom={22}>` is a loose over-zoom setting — the LAYER cap is what matters).
- The limit feeds the overlay LAYER's `maxzoom` **DIRECTLY** (overlay stops past the cap; **no `+1`**).
- `gpx_export` 403 = a **feature-guard** 403: body `{ statusCode: 403, error: "Forbidden", message: "Feature unavailable: gpx_export" }` — **NO** machine `code`. (Only the collaborator LIMIT 403 carries `code: "FEATURE_LIMIT_EXCEEDED"`.) So the client's proactive `features.gpx_export` gate is primary; the 403 is a stale-snapshot safety net keyed on status + endpoint.
- Ships **DARK**: seeds `limit_states(max_trip_collaborators|road_quality_max_zoom, NULL)` (migration 1818) + `gpx_export` force-on mean every gate is inert until go-live; behaviour byte-identical under current data.
- **No backend changes.** No new API endpoints.
- All new user-facing copy = typed `EnglishMessageKey` entries in `src/i18n/locales/en.ts` (key === value); render through `useTranslation()`.
- Mobile is always authenticated on these screens — `isResolved` is false only in the pre-login edge; fail closed there.
- Commit messages: conventional, scope required (`shared`, `mobile`, or `cross`), end with the Co-Authored-By line the executing skill uses.

---

### Task 1: Shared — hoist the overlay-cap math (`clampQualityMaxZoom`)

**Files:**

- Create: `packages/shared/src/quality-zoom.ts`
- Modify: `packages/shared/src/index.ts` (export the new module)
- Test: `packages/shared/src/quality-zoom.spec.ts`
- Modify: `apps/companion/src/lib/map-entitlements.ts` (delegate `resolveQualityLayerMaxZoom` to shared; re-export the free-cap constant)

**Interfaces:**

- Produces: `clampQualityMaxZoom(limit: number | null, isResolved: boolean, sourceCeiling: number): number` and `QUALITY_OVERLAY_FREE_CAP_ZOOM = 12` (both from `@tarmoto/shared`). Consumed by companion (Task 1) and mobile (Task 4).

- [ ] **Step 1: Write the failing shared test**

Create `packages/shared/src/quality-zoom.spec.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  clampQualityMaxZoom,
  QUALITY_OVERLAY_FREE_CAP_ZOOM,
} from "./quality-zoom";

describe("clampQualityMaxZoom", () => {
  it("feeds a resolved finite cap directly, clamped to the source ceiling", () => {
    expect(clampQualityMaxZoom(12, true, 18)).toBe(12);
    expect(clampQualityMaxZoom(14, true, 18)).toBe(14);
    expect(clampQualityMaxZoom(20, true, 18)).toBe(18); // clamp to ceiling
  });
  it("maps a resolved unlimited (null) cap to the source ceiling", () => {
    expect(clampQualityMaxZoom(null, true, 18)).toBe(18);
    expect(clampQualityMaxZoom(null, true, 22)).toBe(22); // platform ceiling honoured
  });
  it("fails closed to the free cap while unresolved with no known cap", () => {
    expect(clampQualityMaxZoom(null, false, 18)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM,
    );
  });
  it("preserves a stricter known finite cap while unresolved (never widens)", () => {
    expect(clampQualityMaxZoom(5, false, 18)).toBe(5);
    expect(clampQualityMaxZoom(20, false, 18)).toBe(
      QUALITY_OVERLAY_FREE_CAP_ZOOM,
    ); // >free → free
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @tarmoto/shared test -- quality-zoom` → FAIL (module not found).

- [ ] **Step 3: Implement the shared module**

Create `packages/shared/src/quality-zoom.ts`:

```ts
/** Free-tier `road_quality_max_zoom` cap — also the fail-closed CEILING while
 *  entitlements are unresolved (a stricter known finite cap still wins). */
export const QUALITY_OVERLAY_FREE_CAP_ZOOM = 12;

/**
 * The overlay LAYER's exclusive `maxzoom` for a resolved `road_quality_max_zoom`
 * limit. The limit feeds maxzoom DIRECTLY (the overlay stops past the cap — no
 * `+1`): finite `N` → `N`; `null` (unlimited) → the platform `sourceCeiling`.
 * Both are clamped to the ceiling (beyond it the vector source over-zooms).
 * Unresolved → fail closed to the free cap, but never WIDEN a stricter finite
 * cap already in hand (e.g. a per-user override mid-refresh). Can only lower.
 */
export function clampQualityMaxZoom(
  limit: number | null,
  isResolved: boolean,
  sourceCeiling: number,
): number {
  if (!isResolved) {
    return limit === null
      ? QUALITY_OVERLAY_FREE_CAP_ZOOM
      : Math.min(limit, QUALITY_OVERLAY_FREE_CAP_ZOOM);
  }
  return limit === null ? sourceCeiling : Math.min(limit, sourceCeiling);
}
```

Add to `packages/shared/src/index.ts` (alongside the other `export * from "./..."` lines):

```ts
export * from "./quality-zoom.js";
```

(Match the existing extension convention in that index — use the same `.js`/no-ext style the neighbouring exports use.)

- [ ] **Step 4: Run the shared test — PASS**

Run: `pnpm --filter @tarmoto/shared test -- quality-zoom` → PASS. Then `pnpm --filter @tarmoto/shared build`.

- [ ] **Step 5: Delegate the companion function to the shared one (no call-site edits)**

In `apps/companion/src/lib/map-entitlements.ts`, replace the local `QUALITY_OVERLAY_FREE_CAP_ZOOM` definition and the `resolveQualityLayerMaxZoom` body so the free cap comes from shared and the clamp delegates — keeping the SAME exported names/signatures (`QUALITY_OVERLAY_FREE_CAP_ZOOM`, `QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM = 18`, and the 2-arg `resolveQualityLayerMaxZoom(limit, isResolved)`):

```ts
import {
  clampQualityMaxZoom,
  QUALITY_OVERLAY_FREE_CAP_ZOOM,
} from "@tarmoto/shared";
export { QUALITY_OVERLAY_FREE_CAP_ZOOM };
export const QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM = 18;

export function resolveQualityLayerMaxZoom(
  limit: number | null,
  isResolved: boolean,
): number {
  return clampQualityMaxZoom(
    limit,
    isResolved,
    QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
  );
}
```

Leave `shouldPromptQualityZoom` and `canSelectRoadAtZoom` untouched. Do NOT touch any companion component or test call-site.

- [ ] **Step 6: Companion still green**

Run: `pnpm --filter @tarmoto/shared build` then `cd apps/companion && npx vitest run src/lib/map-entitlements.test.ts` → PASS (unchanged behaviour: free 12, unlimited 18, stricter-known preserved). Also `npx tsc --noEmit` on companion is clean (a `shared:build` first clears the stale-dist noise).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/quality-zoom.ts packages/shared/src/quality-zoom.spec.ts packages/shared/src/index.ts apps/companion/src/lib/map-entitlements.ts
git commit -m "refactor(shared): hoist overlay-cap math to clampQualityMaxZoom (parameterized ceiling)"
```

---

### Task 2: Mobile foundation — entitlement hooks + lib helpers

**Files:**

- Create: `apps/mobile/src/hooks/useEntitlements.ts`
- Create: `apps/mobile/src/lib/entitlements.ts`
- Test: `apps/mobile/src/hooks/__tests__/useEntitlements.test.ts`, `apps/mobile/src/lib/__tests__/entitlements.test.ts`

**Interfaces:**

- Consumes: `useAuthStore` (`apps/mobile/src/stores/index.ts` — `s.user` is `Schemas["UserResponseDto"]` with `subscription_tier`/`features`/`limits`); `@tarmoto/shared` `isFeatureEnabled`/`getFeatureLimit`/`FEATURE_LIMIT_EXCEEDED`; `ApiError` (`apps/mobile/src/services/api.ts`).
- Produces: `useEntitlements()`, `useFeature(key)`, `useLimit(key)`, `isFeatureLimitError(err)`, `tierLabel(tier, t)`. Consumed by Tasks 3–6.

- [ ] **Step 1: Write failing hook tests**

Create `apps/mobile/src/hooks/__tests__/useEntitlements.test.ts`:

```ts
import { renderHook } from "@testing-library/react-native";
import { useAuthStore } from "@/stores";
import { useEntitlements, useFeature, useLimit } from "@/hooks/useEntitlements";

const baseUser = {
  id: "u1",
  subscription_tier: "free",
  features: { gpx_export: false, basic_navigation: true },
  limits: {
    max_active_trips: 1,
    road_quality_max_zoom: 12,
    max_trip_collaborators: 0,
  },
} as never;

afterEach(() => useAuthStore.setState({ user: null }));

it("reads the resolved snapshot from the auth store", () => {
  useAuthStore.setState({ user: baseUser });
  const { result } = renderHook(() => useEntitlements());
  expect(result.current.tier).toBe("free");
  expect(result.current.isResolved).toBe(true);
});

it("useFeature reads the resolved toggle; fails closed when logged out", () => {
  useAuthStore.setState({ user: baseUser });
  expect(
    renderHook(() => useFeature("gpx_export")).result.current.enabled,
  ).toBe(false);
  useAuthStore.setState({ user: null });
  const r = renderHook(() => useFeature("gpx_export")).result.current;
  expect(r.enabled).toBe(false);
  expect(r.isResolved).toBe(false);
});

it("useLimit reads the resolved numeric cap (null = unlimited)", () => {
  useAuthStore.setState({ user: baseUser });
  expect(
    renderHook(() => useLimit("road_quality_max_zoom")).result.current.limit,
  ).toBe(12);
  useAuthStore.setState({
    user: { ...baseUser, limits: { road_quality_max_zoom: null } } as never,
  });
  expect(
    renderHook(() => useLimit("road_quality_max_zoom")).result.current.limit,
  ).toBeNull();
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd apps/mobile && npx jest src/hooks/__tests__/useEntitlements.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the hooks**

Create `apps/mobile/src/hooks/useEntitlements.ts`:

```ts
import {
  getFeatureLimit,
  isFeatureEnabled,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { useAuthStore } from "@/stores";
import type { User } from "@/types";

/** The server-resolved entitlement snapshot (already cached in the auth store,
 *  refreshed on launch by authBootstrap). `isResolved` is false only when
 *  logged out — gating callers fail closed then. */
export function useEntitlements(): {
  tier: SubscriptionTier | null;
  features: User["features"] | null;
  limits: User["limits"] | null;
  isResolved: boolean;
} {
  const user = useAuthStore((s) => s.user);
  return {
    tier: (user?.subscription_tier as SubscriptionTier | undefined) ?? null,
    features: user?.features ?? null,
    limits: user?.limits ?? null,
    isResolved: user != null,
  };
}

export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isResolved: boolean;
} {
  const { features, isResolved } = useEntitlements();
  return {
    enabled: features ? isFeatureEnabled(features, key) : false,
    isResolved,
  };
}

export function useLimit(key: LimitFeatureKey): {
  limit: number | null;
  isResolved: boolean;
} {
  const { limits, isResolved } = useEntitlements();
  return { limit: limits ? getFeatureLimit(limits, key) : null, isResolved };
}
```

(Confirm the `ToggleFeatureKey`/`LimitFeatureKey`/`SubscriptionTier` type names are the shared exports; if `SubscriptionTier` isn't exported, derive from `User["subscription_tier"]`.)

- [ ] **Step 4: Write failing lib test**

Create `apps/mobile/src/lib/__tests__/entitlements.test.ts`:

```ts
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";
import { ApiError } from "@/services/api";
import { isFeatureLimitError } from "@/lib/entitlements";

it("isFeatureLimitError is true only on a 403 with the FEATURE_LIMIT_EXCEEDED code", () => {
  expect(
    isFeatureLimitError(
      new ApiError("x", 403, { code: FEATURE_LIMIT_EXCEEDED }),
    ),
  ).toBe(true);
  expect(
    isFeatureLimitError(
      new ApiError("x", 403, { message: "Feature unavailable: gpx_export" }),
    ),
  ).toBe(false);
  expect(
    isFeatureLimitError(
      new ApiError("x", 404, { code: FEATURE_LIMIT_EXCEEDED }),
    ),
  ).toBe(false);
  expect(isFeatureLimitError(new Error("nope"))).toBe(false);
});
```

- [ ] **Step 5: Implement `apps/mobile/src/lib/entitlements.ts`**

```ts
import { FEATURE_LIMIT_EXCEEDED, type SubscriptionTier } from "@tarmoto/shared";
import { ApiError } from "@/services/api";
import type { EnglishMessageKey } from "@/i18n/locales";

/** The owner-scoped numeric cap 403 (code FEATURE_LIMIT_EXCEEDED). NOT the
 *  toggle feature-guard 403 ("Feature unavailable: <key>", no code). */
export function isFeatureLimitError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    (err.body as { code?: string } | null)?.code === FEATURE_LIMIT_EXCEEDED
  );
}

const TIER_LABELS: Record<SubscriptionTier, EnglishMessageKey> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

export function tierLabel(
  tier: SubscriptionTier,
  t: (k: EnglishMessageKey) => string,
): string {
  return t(TIER_LABELS[tier]);
}
```

Add the three tier-label keys to `src/i18n/locales/en.ts` (`"Free": "Free"`, `"Pro": "Pro"`, `"Premium": "Premium"`), keeping the file's alphabetical ordering.

- [ ] **Step 6: Run both test files — PASS.** `cd apps/mobile && npx jest src/hooks/__tests__/useEntitlements.test.ts src/lib/__tests__/entitlements.test.ts`. Then `npx tsc --noEmit` clean (run `pnpm --filter @tarmoto/shared build` first if the shared types look stale).

- [ ] **Step 7: Commit** — `feat(mobile): entitlement hooks (useEntitlements/useFeature/useLimit) + lib helpers`.

---

### Task 3: Mobile `<UpgradePrompt>` (RN Modal) + catalog copy

**Files:**

- Create: `apps/mobile/src/components/entitlements/UpgradePrompt.tsx`
- Modify: `apps/mobile/src/i18n/locales/en.ts` (prompt copy)
- Test: `apps/mobile/src/components/entitlements/__tests__/UpgradePrompt.test.tsx`

**Interfaces:**

- Consumes: `upgradeTierForFeature`/`upgradeTierForLimit` (`@tarmoto/shared`), `tierLabel` (Task 2), `useTranslation`, RN `Modal`, the mobile UI primitives used by `ReviewFormModal` (buttons/pressables/text — match that file's imports).
- Produces: `<UpgradePrompt visible capability currentTier message onClose onUpgrade? suppressUpgrade? />`. `onUpgrade` is the IAP seam (optional; when omitted the CTA is a neutral/"coming soon" affordance — no purchase). Consumed by Tasks 4–5.

- [ ] **Step 1: Write the failing component test**

Create `apps/mobile/src/components/entitlements/__tests__/UpgradePrompt.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react-native";
import { I18nProvider } from "@/i18n/I18nProvider";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";

const wrap = (ui: React.ReactElement) =>
  render(<I18nProvider>{ui}</I18nProvider>);

it("shows the upgrade title when a higher tier can lift the cap", () => {
  wrap(
    <UpgradePrompt
      visible
      capability={{ feature: "gpx_export" }}
      currentTier="free"
      message="GPX export is a Pro feature."
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Upgrade required")).toBeTruthy();
  expect(screen.getByText("GPX export is a Pro feature.")).toBeTruthy();
});

it("shows the neutral title when no upgrade can lift it (suppressed/override)", () => {
  wrap(
    <UpgradePrompt
      visible
      capability={{ limit: "max_trip_collaborators", resolvedLimit: 5 }}
      currentTier="pro"
      message="Owner is at the collaborator limit."
      onClose={() => {}}
      suppressUpgrade
    />,
  );
  expect(screen.getByText("Limit reached")).toBeTruthy();
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `UpgradePrompt.tsx`** — port the companion component to RN. Structure (match `ReviewFormModal.tsx`'s Modal + button primitives; use the mobile design tokens):

```tsx
import { Modal, View, Text, Pressable } from "react-native"; // or the app's wrappers
import {
  upgradeTierForFeature,
  upgradeTierForLimit,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { useTranslation } from "@/i18n/I18nProvider";
import { tierLabel } from "@/lib/entitlements";

type UpgradeCapability =
  | { feature: ToggleFeatureKey }
  | { limit: LimitFeatureKey; resolvedLimit: number | null };

export function UpgradePrompt({
  visible,
  capability,
  currentTier,
  message,
  onClose,
  onUpgrade,
  suppressUpgrade = false,
}: {
  visible: boolean;
  capability: UpgradeCapability;
  currentTier: SubscriptionTier;
  message: string;
  onClose: () => void;
  onUpgrade?: () => void; // IAP seam — informational when absent
  suppressUpgrade?: boolean;
}) {
  const t = useTranslation();
  const target = suppressUpgrade
    ? null
    : "feature" in capability
      ? upgradeTierForFeature(capability.feature, currentTier)
      : upgradeTierForLimit(
          capability.limit,
          currentTier,
          capability.resolvedLimit,
        );
  const title = target === null ? t("Limit reached") : t("Upgrade required");
  // CTA: only when a real upgrade target exists. `onUpgrade` wires a future IAP
  // purchase; until then show the target as informational ("Upgrade to Pro" is
  // disabled / "coming soon") so no dead-end billing action is implied.
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* backdrop + card: title, message, Dismiss, and (if target) the upgrade CTA */}
    </Modal>
  );
}
```

Fill in the RN layout using the same styling primitives `ReviewFormModal` uses. The upgrade CTA: `target != null` → a button labelled `t("Upgrade to {tier}", { tier: tierLabel(target, t) })`; `onPress` = `onUpgrade ?? (() => {})` and, when `onUpgrade` is undefined, render it disabled with a `t("Coming soon")` hint or omit the button and show `t("Manage your plan in the Tarmoto app.")`-style copy. Always render a `Dismiss` button calling `onClose`.

- [ ] **Step 4: Catalog copy** — add to `src/i18n/locales/en.ts` (alphabetical): `"Upgrade required"`, `"Limit reached"`, `"Dismiss"`, `"Upgrade to {tier}"`, `"Coming soon"` (or the chosen informational copy), `"GPX export is a Pro feature."`, `"The trip owner has reached their collaborator limit."`, `"Zoom in further for full road-quality detail with Pro."`, `"You've reached the collaborator limit for this trip."` Each key === value.

- [ ] **Step 5: Run the test — PASS.** `npx jest src/components/entitlements/__tests__/UpgradePrompt.test.tsx`; `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit** — `feat(mobile): UpgradePrompt component (IAP-ready seam, informational)`.

---

### Task 4: Gate — road-quality overlay maxzoom clamp (`MapScreen`)

**Files:**

- Modify: `apps/mobile/src/screens/MapScreen.tsx`
- Test: `apps/mobile/src/screens/__tests__/MapScreen.entitlement.test.tsx` (new focused file)

**Interfaces:** Consumes `useLimit` (Task 2), `clampQualityMaxZoom` (Task 1).

- [ ] **Step 1: Write the failing test** — assert the quality `<Layer>` gets `maxzoom` = the resolved cap. Since MapLibre renders nothing headless, assert the prop via a mock of the maplibre `Layer` (mirror how mobile tests the map; if none exists, mock `@maplibre/maplibre-react-native`'s `Layer`/`VectorSource` to capture props). Cases: free (`road_quality_max_zoom` 12) → Layer `maxzoom={12}`; unlimited (`null`) → `maxzoom={18}`; logged out (unresolved) → `maxzoom={12}` (fail closed).

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** In `MapScreen.tsx`:

```ts
import { useLimit } from "@/hooks/useEntitlements";
import { clampQualityMaxZoom } from "@tarmoto/shared";

const MOBILE_QUALITY_CEILING = 18; // the road-tile source's real max (see plan)
const { limit: qualityZoomLimit, isResolved: qualityZoomResolved } = useLimit(
  "road_quality_max_zoom",
);
const qualityMaxZoom = clampQualityMaxZoom(
  qualityZoomLimit,
  qualityZoomResolved,
  MOBILE_QUALITY_CEILING,
);
```

On the quality `<Layer>` (currently `id="tarmoto-quality-lines"`, lines ~530–537) add `maxzoom={qualityMaxZoom}`. Keep the `<VectorSource maxzoom={22}>` as the source over-zoom. Guard the degenerate case: render the quality `<VectorSource>`/`<Layer>` only when `showQualityOverlay && qualityMaxZoom > 0` (an operator override to 0 → hide entirely; mobile's overlay has no minzoom floor, so ordinary caps like 5 give a valid `[0, 5)` range).

- [ ] **Step 4: Run the test — PASS.**

- [ ] **Step 5 (optional discovery prompt — include only if clean):** add a one-shot-per-session `<UpgradePrompt>` when the rider zooms past a FINITE cap with the overlay on AND `upgradeTierForLimit("road_quality_max_zoom", tier ?? "free", limit) !== null`. Read zoom from the existing `onRegionDidChange={handleRegionDidChange}` handler (it receives the region incl. `zoomLevel`); track a `dismissed` state so it fires once. Message: `t("Zoom in further for full road-quality detail with Pro.")`. If the native zoom read is awkward, SKIP this step — the clamp is the enforcement; note the skip in the task report.

- [ ] **Step 6: Commit** — `feat(mobile): clamp road-quality overlay maxzoom to the entitlement cap`.

---

### Task 5: Gate — GPX export (`RideDetailScreen` + `SettingsScreen` bulk)

**Files:**

- Modify: `apps/mobile/src/screens/RideDetailScreen.tsx` (the `handleExportGpx` path, ~568)
- Modify: `apps/mobile/src/screens/SettingsScreen.tsx` (`BulkExportCard`, ~201 — GPX option only; CSV stays free)
- Test: extend/adjust the existing screen tests + a new gate test.

**Interfaces:** Consumes `useFeature("gpx_export")`, `<UpgradePrompt>` (Task 3).

- [ ] **Step 1: Write the failing tests** — for each surface: when `gpx_export` is disabled (auth store user with `features.gpx_export=false`), triggering export opens the `<UpgradePrompt>` (capability `{feature:"gpx_export"}`) and does NOT call `api.exportRideGpx`/`exportAllRidesGpx`; when enabled it exports as before. Mock `api` + set `useAuthStore.setState({ user })`.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.**
- `const { enabled: gpxEnabled, isResolved } = useFeature("gpx_export");` in each screen.
- In the GPX export handler, first: `if (isResolved && !gpxEnabled) { setUpgradeVisible(true); return; }` (a `[upgradeVisible, setUpgradeVisible]` state + `<UpgradePrompt visible={upgradeVisible} capability={{feature:"gpx_export"}} currentTier={tier ?? "free"} message={t("GPX export is a Pro feature.")} onClose={...} />`). While `!isResolved`, disable the control (fail closed).
- 403 safety net: wrap the `exportRideGpx`/`exportAllRidesGpx` call so a **403** on the gpx endpoint (stale snapshot; feature-guard body has no `code`) opens the same upgrade prompt instead of a generic error. Detect via `err instanceof ApiError && err.status === 403` on that specific call.
- `SettingsScreen` `BulkExportCard`: gate only the GPX action; the CSV export stays ungated.

- [ ] **Step 4: Run the tests — PASS.** Re-run the FULL existing `RideDetailScreen`/`SettingsScreen` test files (adding `useFeature` must not break them — they may need `useAuthStore.setState({ user: { features: { gpx_export: true } } })` in setup so existing export assertions still hold).

- [ ] **Step 5: Commit** — `feat(mobile): gate GPX export (single + bulk) on gpx_export`.

---

### Task 6: Gate — trip-join 403 (`JoinTripScreen`)

**Files:**

- Modify: `apps/mobile/src/screens/JoinTripScreen.tsx` (the `catch` at ~79–84)
- Test: `apps/mobile/src/screens/__tests__/JoinTripScreen.test.tsx` (new or extend)

**Interfaces:** Consumes `isFeatureLimitError` (Task 2).

- [ ] **Step 1: Write the failing test** — `api.joinTrip` rejects with `new ApiError("...", 403, { code: FEATURE_LIMIT_EXCEEDED, feature: "max_trip_collaborators", limit: 5, current: 5 })`; assert the error banner shows the owner-cap message (`t("The trip owner has reached their collaborator limit.")`), not the generic API message; and a non-limit error still shows the generic message.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** In the `catch (err)` block:

```ts
const message = isFeatureLimitError(err)
  ? t("The trip owner has reached their collaborator limit.")
  : /* existing generic-message extraction */;
setErrorMessage(message);
```

(The cap is the OWNER's, invisible to the joiner — no proactive gate, message only. Mirrors the companion `SharedTripJoinCta`.)

- [ ] **Step 4: Run the test — PASS.**

- [ ] **Step 5: Commit** — `feat(mobile): show owner collaborator-cap message on a join 403`.

---

## Final validation (after all tasks)

- `cd apps/mobile && npx jest` (full mobile suite) green; `npx tsc --noEmit` clean; `npx eslint src` clean (respect the i18n `no-restricted-syntax` guard — all new copy through `t()`).
- `pnpm --filter @tarmoto/shared test && build`; `cd apps/companion && npx vitest run src/lib/map-entitlements.test.ts && npx tsc --noEmit` (companion unaffected).
- Confirm DARK: with the launch seeds, mobile behaviour is unchanged (free cap seeded unlimited → `qualityMaxZoom` = ceiling; `gpx_export` force-on → export ungated; `max_trip_collaborators` seeded unlimited → join never 403s).
- No backend / OpenAPI changes (no contract regen needed).
