# Companion Entitlement Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-served `/users/me` entitlements (`subscription_tier` + `features` + `limits`) into companion client-side gating, proving it end-to-end on the `max_active_trips` limit with a proactive block + upgrade nudge and a server-403 safety net.

**Architecture:** A `useEntitlements` hook makes the cached `GET /users/me` react-query the single source of truth; `useFeature`/`useLimit` derive from it via the shared pure resolvers. Presentational `<UpgradePrompt>` (inline + modal) and `<FeatureGate>` (toggle) components consume the derived values. The trips page pre-disables trip-minting entry points and shows a usage counter when at the `max_active_trips` limit; the trip-minting mutations (duplicate on the trips page, create/import save on the planner) catch the backend's `FEATURE_LIMIT_EXCEEDED` 403 and surface the same upgrade modal.

**Tech Stack:** TypeScript strict, Next.js companion, `@tanstack/react-query`, `openapi-fetch`/`openapi-react-query` (`@tarmoto/openapi-client`), `@tarmoto/shared` catalog + resolvers, Vitest + `@testing-library/react`, NestJS backend (shared error), ICU-MessageFormat i18n.

## Global Constraints

- **TypeScript strict everywhere.** No `any`; use the shared/generated types.
- **Backend/shared source style:** single quotes, `.js` ESM import suffixes on backend relative imports. **Companion style:** double quotes, no `.js` suffix (path aliases). Prettier runs on commit and normalizes — do not hand-fight it.
- **i18n typed `t()`:** `t` is imported from `@/i18n`; its `key` is the compile-time union `EnglishMessageKey`. **Every new user-facing string MUST first be added to the English catalog** at `apps/companion/src/i18n/locales/en/<domain>.ts` as a flat `"Source string": "Source string"` entry (domain module it's used from, or `common.ts` if shared), or `t("...")` is a compile error. Interpolation uses ICU: `t("{used} of {max} trips", { used, max })`. A key must appear **exactly once** across all catalog modules (`duplicate-keys.test.ts` fails on dupes) — reuse an existing key rather than re-adding it.
- **ESLint `no-restricted-syntax` i18n guard:** raw string literals starting with a letter on `label|title|alt|placeholder|aria-label|ariaLabel` props are errors — wrap them in `t()`. (Raw JSX text children are not flagged, but prefer `t()` for real copy.)
- **Companion CI typechecks test files** — run `pnpm --filter @tarmoto/companion exec tsc --noEmit` after editing tests.
- **After editing `packages/shared`, run `pnpm shared:build`** before typechecking consumers, or the companion sees a stale `@tarmoto/shared` dist.
- **`max_active_trips` server rule (do not diverge):** counts **owner-held** trips with status ∈ `{draft, planned, active}` (NOT `completed`) — `apps/backend/src/modules/trips/trips.service.ts` `OPEN_TRIP_STATUSES`. The limit is seeded `NULL` (unlimited) for all tiers in launch mode, so the gate **ships dark** and only activates when the seed flips. Tests must drive the gate with an explicit non-null limit, never prod data.

---

## File Structure

**Create:**

- `apps/companion/src/hooks/useEntitlements.ts` — the three entitlement hooks.
- `apps/companion/src/hooks/useEntitlements.test.tsx` — hook tests.
- `apps/companion/src/lib/entitlements.ts` — `isFeatureLimitError`, `tierLabel`.
- `apps/companion/src/lib/entitlements.test.ts` — helper tests.
- `apps/companion/src/components/entitlements/UpgradePrompt.tsx` — inline + modal prompt.
- `apps/companion/src/components/entitlements/UpgradePrompt.test.tsx`
- `apps/companion/src/components/entitlements/FeatureGate.tsx` — toggle gate.
- `apps/companion/src/components/entitlements/FeatureGate.test.tsx`

**Modify:**

- `packages/shared/src/feature-flags.ts` — add `FEATURE_LIMIT_EXCEEDED`, `upgradeTierForFeature`, `upgradeTierForLimit`.
- `packages/shared/src/feature-flags.spec.ts` — tests for the new helpers.
- `apps/backend/src/modules/features/feature-limit.error.ts` — import + re-export `FEATURE_LIMIT_EXCEEDED` from shared.
- `apps/companion/src/lib/trip-filters.ts` — add `countOpenOwnedTrips`.
- `apps/companion/src/lib/trip-filters.test.ts` — test the counter (create if absent).
- `apps/companion/src/app/(dashboard)/trips/page.tsx` — proactive block + counter + duplicate 403 modal.
- `apps/companion/src/app/(dashboard)/trips/page.test.tsx` — page gating test (create if absent).
- `apps/companion/src/app/(dashboard)/trips/planner/page.tsx` — create/import save 403 modal.
- `apps/companion/src/app/(dashboard)/settings/subscription/page.tsx` — invalidate `users-me` on mount.
- `apps/companion/src/i18n/locales/en/common.ts` and `.../trips.ts` — new catalog keys.

---

## Task 1: Shared — error-code hoist + tier-upgrade derivation helpers

**Files:**

- Modify: `packages/shared/src/feature-flags.ts`
- Modify: `apps/backend/src/modules/features/feature-limit.error.ts`
- Test: `packages/shared/src/feature-flags.spec.ts`

**Interfaces:**

- Produces:
  - `FEATURE_LIMIT_EXCEEDED: 'FEATURE_LIMIT_EXCEEDED'` (const).
  - `upgradeTierForFeature(key: ToggleFeatureKey): SubscriptionTier | null` — lowest tier granting the toggle.
  - `upgradeTierForLimit(key: LimitFeatureKey, currentTier: SubscriptionTier): SubscriptionTier | null` — lowest tier above `currentTier` with a strictly more generous limit (`null` = unlimited = most generous).
- Consumes: existing `FEATURE_DEFINITIONS`, `SUBSCRIPTION_TIERS`, `ToggleFeatureKey`, `LimitFeatureKey`, `SubscriptionTier` (all already in `feature-flags.ts`).

- [ ] **Step 1: Write the failing tests** in `packages/shared/src/feature-flags.spec.ts` (append inside the existing top-level `describe`, or add a new `describe`):

```ts
import {
  FEATURE_LIMIT_EXCEEDED,
  upgradeTierForFeature,
  upgradeTierForLimit,
} from "./feature-flags.js";

describe("upgrade-tier derivation", () => {
  it("exposes the limit-exceeded wire code", () => {
    expect(FEATURE_LIMIT_EXCEEDED).toBe("FEATURE_LIMIT_EXCEEDED");
  });

  it("finds the lowest tier that grants a toggle", () => {
    expect(upgradeTierForFeature("basic_navigation")).toBe("free"); // all tiers
    expect(upgradeTierForFeature("offline_maps")).toBe("pro"); // pro-and-up
    expect(upgradeTierForFeature("group_rides")).toBe("premium"); // premium-only
  });

  it("finds the lowest tier that raises a numeric limit", () => {
    // max_active_trips: free=1, pro=null (unlimited), premium=null
    expect(upgradeTierForLimit("max_active_trips", "free")).toBe("pro");
    // already unlimited on pro → nothing more generous
    expect(upgradeTierForLimit("max_active_trips", "pro")).toBeNull();
    // max_trip_collaborators: free=0, pro=5, premium=null
    expect(upgradeTierForLimit("max_trip_collaborators", "free")).toBe("pro");
    expect(upgradeTierForLimit("max_trip_collaborators", "pro")).toBe(
      "premium",
    );
  });
});
```

(If `offline_maps`/`group_rides`/`max_trip_collaborators` tier assignments differ in the catalog, adjust the expected values to match `FEATURE_DEFINITIONS` — the _logic_ is what's under test.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tarmoto/shared exec vitest run src/feature-flags.spec.ts`
Expected: FAIL — `upgradeTierForFeature`/`upgradeTierForLimit`/`FEATURE_LIMIT_EXCEEDED` are not exported.

- [ ] **Step 3: Implement in `packages/shared/src/feature-flags.ts`** (add near the other exported helpers):

```ts
/** Machine-readable code carried on limit-rejection 403 bodies (see the
 *  backend `featureLimitExceeded`). Single source of truth for the wire code. */
export const FEATURE_LIMIT_EXCEEDED = "FEATURE_LIMIT_EXCEEDED";

/** Lowest tier (in SUBSCRIPTION_TIERS order) that grants a toggle feature,
 *  or null when no tier grants it / the key is not a toggle. */
export function upgradeTierForFeature(
  key: ToggleFeatureKey,
): SubscriptionTier | null {
  const def = FEATURE_DEFINITIONS[key];
  if (!def || def.kind !== "toggle") return null;
  return SUBSCRIPTION_TIERS.find((tier) => def.tiers.includes(tier)) ?? null;
}

/** `null` = unlimited (most generous); otherwise a larger number is more
 *  generous. */
function isMoreGenerousLimit(
  current: number | null,
  candidate: number | null,
): boolean {
  if (candidate === null) return current !== null;
  if (current === null) return false;
  return candidate > current;
}

/** Lowest tier ABOVE `currentTier` whose `key` limit is strictly more generous
 *  than the current tier's, or null when no higher tier improves it. */
export function upgradeTierForLimit(
  key: LimitFeatureKey,
  currentTier: SubscriptionTier,
): SubscriptionTier | null {
  const def = FEATURE_DEFINITIONS[key];
  if (!def || def.kind !== "limit") return null;
  const currentValue = def.tiers[currentTier];
  const currentIdx = SUBSCRIPTION_TIERS.indexOf(currentTier);
  for (let i = currentIdx + 1; i < SUBSCRIPTION_TIERS.length; i++) {
    const tier = SUBSCRIPTION_TIERS[i]!;
    if (isMoreGenerousLimit(currentValue, def.tiers[tier])) return tier;
  }
  return null;
}
```

- [ ] **Step 4: Point the backend error at the shared constant.** Edit `apps/backend/src/modules/features/feature-limit.error.ts`:

```ts
import { ForbiddenException } from "@nestjs/common";
import { FEATURE_LIMIT_EXCEEDED, type LimitFeatureKey } from "@tarmoto/shared";

/** Re-exported so existing importers of this module keep working. */
export { FEATURE_LIMIT_EXCEEDED };

export function featureLimitExceeded(
  feature: LimitFeatureKey,
  limit: number,
  current: number,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: "Forbidden",
    message: `Feature limit exceeded: ${feature} (limit ${limit}, current ${current})`,
    code: FEATURE_LIMIT_EXCEEDED,
    feature,
    limit,
    current,
  });
}
```

(Delete the old local `export const FEATURE_LIMIT_EXCEEDED = '...'` line. The three backend specs that import `FEATURE_LIMIT_EXCEEDED` from this module — `sharing.service.spec.ts`, `trip-generator.service.spec.ts`, `trips.service.spec.ts` — keep resolving via the re-export.)

- [ ] **Step 5: Build shared, then run the tests**

Run: `pnpm shared:build && pnpm --filter @tarmoto/shared exec vitest run src/feature-flags.spec.ts`
Expected: PASS.

- [ ] **Step 6: Verify the backend still compiles**

Run: `pnpm --filter @tarmoto/backend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/feature-flags.ts packages/shared/src/feature-flags.spec.ts apps/backend/src/modules/features/feature-limit.error.ts
git commit -m "feat(shared): hoist FEATURE_LIMIT_EXCEEDED + add upgrade-tier derivation helpers"
```

---

## Task 2: Companion entitlement hooks (`useEntitlements`/`useFeature`/`useLimit`)

**Files:**

- Create: `apps/companion/src/hooks/useEntitlements.ts`
- Modify: `apps/companion/src/hooks/index.ts` (re-export)
- Test: `apps/companion/src/hooks/useEntitlements.test.tsx`

**Interfaces:**

- Consumes: `api.GET` from `@/lib/api`; `useAuthStore` from `@/stores/auth`; `isFeatureEnabled`, `getFeatureLimit`, `ToggleFeatureKey`, `LimitFeatureKey`, `SubscriptionTier` from `@tarmoto/shared`; `UserProfileResponse` from `@/lib/api/users`.
- Produces:
  - `USERS_ME_QUERY_KEY(userId: string | null): readonly ['users-me', string | null]`
  - `useEntitlements(): { tier: SubscriptionTier | null; features: UserProfileResponse['features'] | null; limits: UserProfileResponse['limits'] | null; isLoading: boolean }`
  - `useFeature(key: ToggleFeatureKey): { enabled: boolean; isLoading: boolean }`
  - `useLimit(key: LimitFeatureKey): { limit: number | null; isLoading: boolean }`

- [ ] **Step 1: Write the failing test** `apps/companion/src/hooks/useEntitlements.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { withQueryClient } from "./test-utils";

const getMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { GET: (...a: unknown[]) => getMock(...a) },
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) =>
    sel({ user: { id: "u1" } }),
}));

import { useEntitlements, useFeature, useLimit } from "./useEntitlements";

const ME = {
  id: "u1",
  subscription_tier: "free",
  features: { group_rides: false, basic_navigation: true },
  limits: { max_active_trips: 1, max_trip_collaborators: 0 },
};

describe("useEntitlements", () => {
  beforeEach(() => getMock.mockReset());

  it("exposes the resolved tier/features/limits from /users/me", async () => {
    getMock.mockResolvedValue({ data: ME, error: undefined });
    const { result } = renderHook(() => useEntitlements(), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith("/api/v1/users/me", {
      signal: expect.anything(),
    });
    expect(result.current.tier).toBe("free");
    expect(result.current.limits?.max_active_trips).toBe(1);
  });

  it("useFeature indexes the resolved snapshot (does not re-resolve from tier)", async () => {
    getMock.mockResolvedValue({ data: ME, error: undefined });
    const { result } = renderHook(() => useFeature("group_rides"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it("useLimit returns the resolved numeric limit", async () => {
    getMock.mockResolvedValue({ data: ME, error: undefined });
    const { result } = renderHook(() => useLimit("max_active_trips"), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.limit).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/hooks/useEntitlements.test.tsx`
Expected: FAIL — module `./useEntitlements` not found.

- [ ] **Step 3: Implement `apps/companion/src/hooks/useEntitlements.ts`**:

```ts
import { useQuery } from "@tanstack/react-query";
import {
  getFeatureLimit,
  isFeatureEnabled,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { api } from "@/lib/api";
import type { UserProfileResponse } from "@/lib/api/users";
import { useAuthStore } from "@/stores/auth";

export const USERS_ME_QUERY_KEY = (userId: string | null) =>
  ["users-me", userId] as const;

/**
 * Single source of truth for the rider's resolved entitlements. Reads the
 * cached `GET /users/me` response (server-resolved `features`/`limits` — global
 * overrides already applied) and refetches on window focus so an upgrade taken
 * in another tab lands promptly. UI code consumes the derived hooks below, not
 * this snapshot directly.
 */
export function useEntitlements(): {
  tier: SubscriptionTier | null;
  features: UserProfileResponse["features"] | null;
  limits: UserProfileResponse["limits"] | null;
  isLoading: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const query = useQuery({
    queryKey: USERS_ME_QUERY_KEY(userId),
    enabled: userId != null,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/users/me", { signal });
      if (error || !data) throw new Error("Failed to load entitlements");
      return data;
    },
  });
  const data = query.data ?? null;
  return {
    tier: (data?.subscription_tier as SubscriptionTier | undefined) ?? null,
    features: data?.features ?? null,
    limits: data?.limits ?? null,
    isLoading: query.isLoading,
  };
}

/** Whether a tier-locked toggle is granted. `enabled` is false while loading
 *  or unknown — callers that must avoid a locked-state flash should gate on
 *  `isLoading`. */
export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isLoading: boolean;
} {
  const { features, isLoading } = useEntitlements();
  return {
    enabled: features ? isFeatureEnabled(features, key) : false,
    isLoading,
  };
}

/** The resolved numeric limit (`null` = unlimited; also `null` while
 *  unresolved — callers gate on `isLoading`). */
export function useLimit(key: LimitFeatureKey): {
  limit: number | null;
  isLoading: boolean;
} {
  const { limits, isLoading } = useEntitlements();
  return {
    limit: limits ? getFeatureLimit(limits, key, null) : null,
    isLoading,
  };
}
```

- [ ] **Step 4: Re-export from the hooks barrel.** Add to `apps/companion/src/hooks/index.ts`:

```ts
export {
  useEntitlements,
  useFeature,
  useLimit,
  USERS_ME_QUERY_KEY,
} from "./useEntitlements";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/hooks/useEntitlements.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck (includes test files)**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/companion/src/hooks/useEntitlements.ts apps/companion/src/hooks/useEntitlements.test.tsx apps/companion/src/hooks/index.ts
git commit -m "feat(companion): entitlement hooks reading resolved /users/me snapshot"
```

---

## Task 3: Companion pure helpers — `isFeatureLimitError`, `tierLabel`, `countOpenOwnedTrips`

**Files:**

- Create: `apps/companion/src/lib/entitlements.ts`
- Create: `apps/companion/src/lib/entitlements.test.ts`
- Modify: `apps/companion/src/lib/trip-filters.ts`
- Test: `apps/companion/src/lib/trip-filters.test.ts` (create if absent)

**Interfaces:**

- Consumes: `ApiError` from `@/lib/api`; `FEATURE_LIMIT_EXCEEDED`, `SubscriptionTier` from `@tarmoto/shared`; `TripSummary` from `@/lib/types`; `TripStatus` from `@/lib/trip-filters`.
- Produces:
  - `isFeatureLimitError(error: unknown): boolean`
  - `tierLabel(tier: SubscriptionTier): string` → `"Free" | "Pro" | "Premium"`
  - `countOpenOwnedTrips(trips: readonly TripSummary[], userId: string | null): number`

- [ ] **Step 1: Write the failing tests.** `apps/companion/src/lib/entitlements.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";
import { isFeatureLimitError, tierLabel } from "./entitlements";

describe("isFeatureLimitError", () => {
  it("recognizes a 403 with the FEATURE_LIMIT_EXCEEDED code", () => {
    const err = new ApiError(403, { code: FEATURE_LIMIT_EXCEEDED });
    expect(isFeatureLimitError(err)).toBe(true);
  });
  it("rejects other 403s and non-ApiError values", () => {
    expect(isFeatureLimitError(new ApiError(403, { code: "OTHER" }))).toBe(
      false,
    );
    expect(isFeatureLimitError(new ApiError(500, {}))).toBe(false);
    expect(isFeatureLimitError(new Error("nope"))).toBe(false);
  });
});

describe("tierLabel", () => {
  it("maps tiers to display names", () => {
    expect(tierLabel("free")).toBe("Free");
    expect(tierLabel("pro")).toBe("Pro");
    expect(tierLabel("premium")).toBe("Premium");
  });
});
```

And in `apps/companion/src/lib/trip-filters.test.ts` (append, or create with these imports):

```ts
import { describe, it, expect } from "vitest";
import { countOpenOwnedTrips } from "./trip-filters";
import type { TripSummary } from "@/lib/types";

const trip = (over: Partial<TripSummary>): TripSummary =>
  ({ id: "t", status: "draft", owner_id: "me", ...over }) as TripSummary;

describe("countOpenOwnedTrips", () => {
  it("counts owner-held draft/planned/active trips only", () => {
    const trips = [
      trip({ id: "a", status: "draft", owner_id: "me" }),
      trip({ id: "b", status: "planned", owner_id: "me" }),
      trip({ id: "c", status: "active", owner_id: "me" }),
      trip({ id: "d", status: "completed", owner_id: "me" }), // excluded
      trip({ id: "e", status: "draft", owner_id: "other" }), // not owner
    ];
    expect(countOpenOwnedTrips(trips, "me")).toBe(3);
  });
  it("returns 0 with no user", () => {
    expect(countOpenOwnedTrips([trip({})], null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/lib/entitlements.test.ts src/lib/trip-filters.test.ts`
Expected: FAIL — `./entitlements` missing; `countOpenOwnedTrips` not exported.

- [ ] **Step 3a: Create `apps/companion/src/lib/entitlements.ts`**:

```ts
import { ApiError } from "@/lib/api";
import { FEATURE_LIMIT_EXCEEDED, type SubscriptionTier } from "@tarmoto/shared";

const TIER_LABEL: Record<SubscriptionTier, string> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

/** Display name for a subscription tier (English-only until i18n covers it). */
export function tierLabel(tier: SubscriptionTier): string {
  return TIER_LABEL[tier];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True for the backend's `featureLimitExceeded` rejection (403 +
 *  `code: FEATURE_LIMIT_EXCEEDED`) so mint paths can surface the upgrade
 *  prompt instead of a generic error. */
export function isFeatureLimitError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    isRecord(error.body) &&
    error.body.code === FEATURE_LIMIT_EXCEEDED
  );
}
```

(Confirm `ApiError`'s constructor signature is `(status, body)` — per `apps/companion/src/lib/api/client.ts`. If it differs, adjust the test's `new ApiError(...)` calls to match; the helper only reads `.status` and `.body`.)

- [ ] **Step 3b: Add `countOpenOwnedTrips` to `apps/companion/src/lib/trip-filters.ts`**. Ensure `TripSummary` is imported (add `import type { TripSummary } from "@/lib/types";` if not already present), then append:

```ts
/**
 * Trips that count against `max_active_trips`, mirroring the backend rule
 * (`apps/backend/src/modules/trips/trips.service.ts` OPEN_TRIP_STATUSES):
 * owner-held trips in draft/planned/active — NOT completed.
 */
const OPEN_TRIP_STATUSES: readonly TripStatus[] = [
  "draft",
  "planned",
  "active",
];

export function countOpenOwnedTrips(
  trips: readonly TripSummary[],
  userId: string | null,
): number {
  if (!userId) return 0;
  return trips.filter(
    (t) => t.owner_id === userId && OPEN_TRIP_STATUSES.includes(t.status),
  ).length;
}
```

(`TripStatus` is already defined/exported in this module. If a `TripSummary`'s `status` type is wider than `TripStatus`, the `.includes` still narrows correctly.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/lib/entitlements.test.ts src/lib/trip-filters.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/lib/entitlements.ts apps/companion/src/lib/entitlements.test.ts apps/companion/src/lib/trip-filters.ts apps/companion/src/lib/trip-filters.test.ts
git commit -m "feat(companion): entitlement lib helpers (limit-error, tier label, open-trip count)"
```

---

## Task 4: `<UpgradePrompt>` component (inline + modal)

**Files:**

- Create: `apps/companion/src/components/entitlements/UpgradePrompt.tsx`
- Test: `apps/companion/src/components/entitlements/UpgradePrompt.test.tsx`
- Modify: `apps/companion/src/i18n/locales/en/common.ts`

**Interfaces:**

- Consumes: `upgradeTierForFeature`, `upgradeTierForLimit`, `ToggleFeatureKey`, `LimitFeatureKey`, `SubscriptionTier` from `@tarmoto/shared`; `tierLabel` from `@/lib/entitlements` (Task 3); `Button`, `Card`, `Heading` from `@tarmoto/ui`; `useRouter` from `next/navigation`; `t` from `@/i18n`.
- Produces: `UpgradePrompt` component with props:

  ```ts
  type UpgradeCapability =
    { feature: ToggleFeatureKey } | { limit: LimitFeatureKey };
  interface UpgradePromptProps {
    capability: UpgradeCapability;
    currentTier: SubscriptionTier;
    message: string; // already-localized contextual reason
    variant: "inline" | "modal";
    onClose?: () => void; // modal only
  }
  ```

- [ ] **Step 1: Add catalog keys** to `apps/companion/src/i18n/locales/en/common.ts` (insert as flat entries, keep the module's alphabetical ordering if it has one):

```ts
  "Upgrade to {tier}": "Upgrade to {tier}",
  "Upgrade required": "Upgrade required",
  "Dismiss": "Dismiss",
```

- [ ] **Step 2: Write the failing test** `apps/companion/src/components/entitlements/UpgradePrompt.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import { UpgradePrompt } from "./UpgradePrompt";

describe("UpgradePrompt", () => {
  it("derives the target tier for a limit and renders the CTA + message", () => {
    render(
      <UpgradePrompt
        variant="inline"
        capability={{ limit: "max_active_trips" }}
        currentTier="free"
        message="You've hit your limit."
      />,
    );
    expect(screen.getByText("You've hit your limit.")).toBeTruthy();
    // max_active_trips free→pro
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeTruthy();
  });

  it("renders a modal dialog with a dismiss control", () => {
    render(
      <UpgradePrompt
        variant="modal"
        capability={{ feature: "group_rides" }}
        currentTier="free"
        message="Group rides need Premium."
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    // group_rides is premium-only
    expect(
      screen.getByRole("button", { name: /Upgrade to Premium/i }),
    ).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/components/entitlements/UpgradePrompt.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `apps/companion/src/components/entitlements/UpgradePrompt.tsx`**:

```tsx
"use client";
import { useRouter } from "next/navigation";
import {
  upgradeTierForFeature,
  upgradeTierForLimit,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { Button, Card, Heading } from "@tarmoto/ui";
import { t } from "@/i18n";
import { tierLabel } from "@/lib/entitlements";

type UpgradeCapability =
  { feature: ToggleFeatureKey } | { limit: LimitFeatureKey };

interface UpgradePromptProps {
  capability: UpgradeCapability;
  currentTier: SubscriptionTier;
  /** Already-localized contextual reason. */
  message: string;
  variant: "inline" | "modal";
  onClose?: () => void;
}

const SUBSCRIPTION_ROUTE = "/settings/subscription";

function resolveTarget(
  capability: UpgradeCapability,
  currentTier: SubscriptionTier,
): SubscriptionTier | null {
  return "feature" in capability
    ? upgradeTierForFeature(capability.feature)
    : upgradeTierForLimit(capability.limit, currentTier);
}

export function UpgradePrompt({
  capability,
  currentTier,
  message,
  variant,
  onClose,
}: UpgradePromptProps) {
  const router = useRouter();
  const target = resolveTarget(capability, currentTier);

  const cta =
    target === null ? null : (
      <Button
        variant="accent"
        size="sm"
        onClick={() => router.push(SUBSCRIPTION_ROUTE)}
      >
        {t("Upgrade to {tier}", { tier: tierLabel(target) })}
      </Button>
    );

  if (variant === "modal") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("Upgrade required")}
          className="w-full max-w-md rounded-[14px] border border-line bg-cream p-6"
        >
          <Heading size="md" as="h2">
            {t("Upgrade required")}
          </Heading>
          <p className="mt-2 text-[13px] text-ink/80">{message}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("Dismiss")}
            </Button>
            {cta}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card variant="ink" padded>
      <p className="text-[13px]">{message}</p>
      {cta ? <div className="mt-3">{cta}</div> : null}
    </Card>
  );
}
```

(If `@tarmoto/ui` `Card` has no `variant="ink"`/`padded` props exactly as written, use the closest available props — the component contract is what matters, not the exact card styling. Keep the `role="dialog"`/`aria-modal` and the CTA/message structure the tests assert.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/components/entitlements/UpgradePrompt.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint the new files**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec eslint src/components/entitlements/UpgradePrompt.tsx`
Expected: no errors (no raw label/title literals — `aria-label` uses `t()`).

- [ ] **Step 7: Commit**

```bash
git add apps/companion/src/components/entitlements/UpgradePrompt.tsx apps/companion/src/components/entitlements/UpgradePrompt.test.tsx apps/companion/src/i18n/locales/en/common.ts
git commit -m "feat(companion): UpgradePrompt component (inline + modal) with catalog-derived target tier"
```

---

## Task 5: `<FeatureGate>` component (toggle gating primitive)

**Files:**

- Create: `apps/companion/src/components/entitlements/FeatureGate.tsx`
- Test: `apps/companion/src/components/entitlements/FeatureGate.test.tsx`
- Modify: `apps/companion/src/i18n/locales/en/common.ts`

**Interfaces:**

- Consumes: `useFeature`, `useEntitlements` from `@/hooks` (Task 2); `UpgradePrompt` from `./UpgradePrompt` (Task 4); `ToggleFeatureKey` from `@tarmoto/shared`; `t` from `@/i18n`.
- Produces: `FeatureGate` component:

  ```ts
  interface FeatureGateProps {
    feature: ToggleFeatureKey;
    children: React.ReactNode;
    /** Rendered while entitlements are loading (default: null — no flash). */
    loadingFallback?: React.ReactNode;
  }
  ```

  Renders `children` when enabled; a locked `<UpgradePrompt variant="inline">` when not; `loadingFallback` while loading.

- [ ] **Step 1: Add the locked-copy catalog key** to `apps/companion/src/i18n/locales/en/common.ts`:

```ts
  "This feature isn't on your plan.": "This feature isn't on your plan.",
```

- [ ] **Step 2: Write the failing test** `apps/companion/src/components/entitlements/FeatureGate.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useFeatureMock = vi.fn();
const useEntitlementsMock = vi.fn();
vi.mock("@/hooks", () => ({
  useFeature: (k: string) => useFeatureMock(k),
  useEntitlements: () => useEntitlementsMock(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { FeatureGate } from "./FeatureGate";

describe("FeatureGate", () => {
  beforeEach(() => {
    useFeatureMock.mockReset();
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
  });

  it("renders children when the feature is enabled", () => {
    useFeatureMock.mockReturnValue({ enabled: true, isLoading: false });
    render(
      <FeatureGate feature="group_rides">
        <span>Group rides UI</span>
      </FeatureGate>,
    );
    expect(screen.getByText("Group rides UI")).toBeTruthy();
  });

  it("renders the upgrade prompt when locked", () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: false });
    render(
      <FeatureGate feature="group_rides">
        <span>Group rides UI</span>
      </FeatureGate>,
    );
    expect(screen.queryByText("Group rides UI")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Upgrade to Premium/i }),
    ).toBeTruthy();
  });

  it("renders neither children nor prompt while loading", () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: true });
    render(
      <FeatureGate feature="group_rides">
        <span>Group rides UI</span>
      </FeatureGate>,
    );
    expect(screen.queryByText("Group rides UI")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/components/entitlements/FeatureGate.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `apps/companion/src/components/entitlements/FeatureGate.tsx`**:

```tsx
"use client";
import type { ReactNode } from "react";
import type { ToggleFeatureKey } from "@tarmoto/shared";
import { useEntitlements, useFeature } from "@/hooks";
import { t } from "@/i18n";
import { UpgradePrompt } from "./UpgradePrompt";

interface FeatureGateProps {
  feature: ToggleFeatureKey;
  children: ReactNode;
  /** Rendered while entitlements load — default null (no locked-state flash). */
  loadingFallback?: ReactNode;
}

export function FeatureGate({
  feature,
  children,
  loadingFallback = null,
}: FeatureGateProps) {
  const { enabled, isLoading } = useFeature(feature);
  const { tier } = useEntitlements();

  if (isLoading || !tier) return <>{loadingFallback}</>;
  if (enabled) return <>{children}</>;

  return (
    <UpgradePrompt
      variant="inline"
      capability={{ feature }}
      currentTier={tier}
      message={t("This feature isn't on your plan.")}
    />
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tarmoto/companion exec vitest run src/components/entitlements/FeatureGate.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/companion/src/components/entitlements/FeatureGate.tsx apps/companion/src/components/entitlements/FeatureGate.test.tsx apps/companion/src/i18n/locales/en/common.ts
git commit -m "feat(companion): FeatureGate toggle-gating primitive"
```

---

## Task 6: Trips page — proactive block + counter + duplicate 403 safety net

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/trips/page.tsx`
- Modify: `apps/companion/src/i18n/locales/en/trips.ts`
- Test: `apps/companion/src/app/(dashboard)/trips/page.test.tsx` (create if absent, following the mock scaffold of `apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx`)

**Interfaces:**

- Consumes: `useEntitlements`, `useLimit` from `@/hooks`; `countOpenOwnedTrips` from `@/lib/trip-filters`; `isFeatureLimitError`, `tierLabel` from `@/lib/entitlements`; `UpgradePrompt` from `@/components/entitlements/UpgradePrompt`.
- Produces: gated trip-minting entry points on the trips page (behavioral; no new exports).

- [ ] **Step 1: Add catalog keys** to `apps/companion/src/i18n/locales/en/trips.ts`:

```ts
  "{used} of {max} trips used on the {tier} plan.":
    "{used} of {max} trips used on the {tier} plan.",
  "You've reached your trip limit on the {tier} plan.":
    "You've reached your trip limit on the {tier} plan.",
```

- [ ] **Step 2: Write the failing test** `apps/companion/src/app/(dashboard)/trips/page.test.tsx`. Reuse the mock scaffold from `planner/page.test.tsx` for the heavy dependencies (auth store, trip store, `tripsApi`, `next/navigation`), and add the entitlement-specific mocks + assertions below. The decisive additions:

```tsx
// --- entitlement mocks (add alongside the existing page mocks) ---
const useLimitMock = vi.fn();
vi.mock("@/hooks", async (orig) => ({
  ...(await orig<typeof import("@/hooks")>()),
  useEntitlements: () => ({ tier: "free" }),
  useLimit: (k: string) => useLimitMock(k),
}));

// Seed the trip store with exactly one open owned trip for "me".
// (Follow the existing scaffold's helper for populating useTripStore;
//  each seeded trip needs { owner_id: "me", status: "draft" }.)

describe("trips page — max_active_trips gate", () => {
  beforeEach(() => useLimitMock.mockReset());

  it("blocks minting and shows the counter when at the limit", async () => {
    useLimitMock.mockReturnValue({ limit: 1, isLoading: false });
    // ...render the page with one open owned trip for user "me"...
    expect(
      await screen.findByText(/1 of 1 trips used on the Free plan/i),
    ).toBeTruthy();
    // The "New trip" control is a disabled button (not an enabled link).
    const newTrip = screen.getByRole("button", { name: /New trip/i });
    expect(newTrip).toHaveProperty("disabled", true);
  });

  it("leaves minting enabled when the limit is unlimited", async () => {
    useLimitMock.mockReturnValue({ limit: null, isLoading: false });
    // ...render with one open owned trip...
    expect(screen.queryByText(/trips used on the/i)).toBeNull();
    expect(screen.getByRole("link", { name: /New trip/i })).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/app/(dashboard)/trips/page.test.tsx"`
Expected: FAIL — no counter text; "New trip" is still a link, not a disabled button.

- [ ] **Step 4: Wire the gate into `trips/page.tsx`.**

4a. Add imports at the top:

```ts
import { useEntitlements, useLimit } from "@/hooks";
import { countOpenOwnedTrips } from "@/lib/trip-filters";
import { isFeatureLimitError, tierLabel } from "@/lib/entitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
```

4b. Near the existing `const userId = useAuthStore((s) => s.user?.id ?? null);` (line ~92) and the `const trips = useTripStore((s) => s.trips);` selector, compute the gate state:

```ts
const { tier } = useEntitlements();
const { limit: maxActiveTrips } = useLimit("max_active_trips");
const openTripCount = countOpenOwnedTrips(trips, userId);
const atTripLimit = maxActiveTrips !== null && openTripCount >= maxActiveTrips;
```

4c. In the `PageHeader` `right` prop (lines ~484-501), replace the two `<Link>` actions with limit-aware rendering. When `atTripLimit`, render disabled `<button>`s carrying the same classes (so they read as blocked); otherwise keep the links:

```tsx
right={
  <div className="flex items-center gap-2">
    {atTripLimit ? (
      <>
        <button
          type="button"
          disabled
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-paper px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink opacity-50"
        >
          <FileUp size={14} />
          {t("Import GPX")}
        </button>
        <button
          type="button"
          disabled
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink opacity-50"
        >
          <Plus size={14} />
          {t("New trip")}
        </button>
      </>
    ) : (
      <>
        <Link href="/trips/planner?import=1" className="...unchanged...">
          <FileUp size={14} />
          {t("Import GPX")}
        </Link>
        <Link href="/trips/planner" className="...unchanged...">
          <Plus size={14} />
          {t("New trip")}
        </Link>
      </>
    )}
  </div>
}
```

(Keep the exact original `className` strings on the `<Link>`s — copy them from the current file, do not paraphrase.)

4d. Render the inline upgrade prompt + counter in the page body, next to the existing `errorBanner` region (lines ~504-516), so it appears above the trip list:

```tsx
{
  atTripLimit && tier && maxActiveTrips !== null ? (
    <div className="mb-4">
      <UpgradePrompt
        variant="inline"
        capability={{ limit: "max_active_trips" }}
        currentTier={tier}
        message={t("{used} of {max} trips used on the {tier} plan.", {
          used: openTripCount,
          max: maxActiveTrips,
          tier: tierLabel(tier),
        })}
      />
    </div>
  ) : null;
}
```

4e. Add the duplicate-mint 403 safety net. Add local modal state near the other `useState` hooks:

```ts
const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
```

In `duplicateTrip` (lines ~361-391), change the `catch` to route the limit error to the modal:

```ts
  } catch (err) {
    if (isFeatureLimitError(err)) {
      setUpgradeModalOpen(true);
    } else {
      setErrorBanner("Couldn't duplicate the trip. Try again.");
    }
  } finally {
    clearBusy(trip.id);
  }
```

And render the modal once (e.g. near the other conditionally-rendered dialogs at the end of the returned JSX):

```tsx
{
  upgradeModalOpen && tier ? (
    <UpgradePrompt
      variant="modal"
      capability={{ limit: "max_active_trips" }}
      currentTier={tier}
      message={t("You've reached your trip limit on the {tier} plan.", {
        tier: tierLabel(tier),
      })}
      onClose={() => setUpgradeModalOpen(false)}
    />
  ) : null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/app/(dashboard)/trips/page.test.tsx"`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec eslint "src/app/(dashboard)/trips/page.tsx"`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add "apps/companion/src/app/(dashboard)/trips/page.tsx" "apps/companion/src/app/(dashboard)/trips/page.test.tsx" apps/companion/src/i18n/locales/en/trips.ts
git commit -m "feat(companion): gate trip minting on max_active_trips (proactive block + counter + 403 modal)"
```

---

## Task 7: Planner create/import 403 safety net + entitlement refresh wiring

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx`
- Modify: `apps/companion/src/app/(dashboard)/settings/subscription/page.tsx`

**Interfaces:**

- Consumes: `useEntitlements` from `@/hooks`; `isFeatureLimitError`, `tierLabel` from `@/lib/entitlements`; `UpgradePrompt` from `@/components/entitlements/UpgradePrompt`; catalog key `"You've reached your trip limit on the {tier} plan."` (added in Task 6 — reuse, do NOT re-add); `useQueryClient` from `@tanstack/react-query`.
- Produces: planner save-path upgrade modal; `users-me` cache invalidation on the subscription page.

- [ ] **Step 1: Wire the planner save catch.** In `planner/page.tsx`:

1a. Imports:

```ts
import { useEntitlements } from "@/hooks";
import { isFeatureLimitError, tierLabel } from "@/lib/entitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
```

1b. Near the component's other hooks, add tier + modal state:

```ts
const { tier } = useEntitlements();
const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
```

1c. In the save `catch` block (currently `toast.error(t("Could not save this trip. Please try again."));` at lines ~1516-1519), route the limit error to the modal:

```ts
} catch (err) {
  if (isFeatureLimitError(err)) {
    setUpgradeModalOpen(true);
  } else {
    toast.error(t("Could not save this trip. Please try again."));
    console.warn("Failed to save trip", err);
  }
  setSaving(false);
```

1d. Render the modal once in the returned JSX (near other dialogs):

```tsx
{
  upgradeModalOpen && tier ? (
    <UpgradePrompt
      variant="modal"
      capability={{ limit: "max_active_trips" }}
      currentTier={tier}
      message={t("You've reached your trip limit on the {tier} plan.", {
        tier: tierLabel(tier),
      })}
      onClose={() => setUpgradeModalOpen(false)}
    />
  ) : null;
}
```

- [ ] **Step 2: Add refresh wiring** in `settings/subscription/page.tsx`. Import and invalidate the entitlement query on mount (so a tier change from a Stripe checkout/portal round-trip is reflected once the rider returns to billing):

```ts
import { useQueryClient } from "@tanstack/react-query";
// ...inside the component:
const queryClient = useQueryClient();
useEffect(() => {
  // Entitlements (tier/features/limits) may have changed via checkout/portal.
  void queryClient.invalidateQueries({ queryKey: ["users-me"] });
}, [queryClient]);
```

(`["users-me"]` is the `USERS_ME_QUERY_KEY` prefix — a partial-match invalidation covering the signed-in rider.)

- [ ] **Step 3: Typecheck + lint the two files**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec eslint "src/app/(dashboard)/trips/planner/page.tsx" "src/app/(dashboard)/settings/subscription/page.tsx"`
Expected: no errors.

- [ ] **Step 4: Run the planner + subscription test suites to confirm no regression**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/app/(dashboard)/trips/planner" "src/app/(dashboard)/settings/subscription"`
Expected: PASS (existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add "apps/companion/src/app/(dashboard)/trips/planner/page.tsx" "apps/companion/src/app/(dashboard)/settings/subscription/page.tsx"
git commit -m "feat(companion): planner save 403 upgrade modal + refresh entitlements on billing"
```

---

## Task 8: Full validation + PR

**Files:** none (validation + PR only).

- [ ] **Step 1: Build shared (consumers depend on fresh dist)**

Run: `pnpm shared:build`
Expected: success.

- [ ] **Step 2: Full companion test suite**

Run: `pnpm --filter @tarmoto/companion test`
Expected: all pass (including the i18n `duplicate-keys.test.ts` — confirms no duplicate catalog keys were introduced).

- [ ] **Step 3: Companion typecheck (test files included) + lint**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion lint`
Expected: no errors.

- [ ] **Step 4: Backend build + affected specs (shared error hoist)**

Run: `pnpm --filter @tarmoto/backend exec tsc --noEmit && pnpm --filter @tarmoto/backend exec vitest run src/modules/features src/modules/trips src/modules/sharing`
Expected: PASS. (If the backend uses Jest rather than Vitest, run its configured unit-test command scoped to those paths instead.)

- [ ] **Step 5: Shared test suite**

Run: `pnpm --filter @tarmoto/shared test`
Expected: PASS.

- [ ] **Step 6: OpenAPI generation sanity (contract unchanged)**

Run: `pnpm --filter @tarmoto/openapi gen` (or the repo's `openapi:gen` script)
Expected: success with **no diff** to the generated spec — this change adds no DTO/endpoint. `git status` should show no `packages/openapi` changes.

- [ ] **Step 7: Request code review**

Use superpowers:requesting-code-review for the whole branch. Address findings, re-run Steps 2-6 after any fix.

- [ ] **Step 8: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(companion): entitlement foundation + max_active_trips gating" --body "$(cat <<'EOF'
## Summary
Wires the already-served `/users/me` entitlements (`subscription_tier` + `features` + `limits`) into companion client-side gating. Sub-project 1 of the client-consumption epic.

- `useEntitlements`/`useFeature`/`useLimit` hooks (single source of truth = cached `GET /users/me`).
- `<UpgradePrompt>` (inline + modal) with catalog-derived upgrade target tier; `<FeatureGate>` toggle primitive.
- Proof surface: `max_active_trips` on the trips page — proactive block (disabled New/Import + usage counter + inline prompt) with a server-403 safety net on the duplicate + planner create/import mint paths.
- Entitlements refresh on window focus and on the billing page (post-checkout).

## Contract / migration impact
None. No DTO/endpoint/migration changes. `FEATURE_LIMIT_EXCEEDED` hoisted to `@tarmoto/shared` (backend re-exports it); OpenAPI output byte-identical.

## Ships dark
`max_active_trips` is seeded unlimited in launch mode, so the gate is inert in prod until the seed flips at monetization go-live.

## Tests
Shared helper unit tests; companion hook/component/lib unit tests; trips-page gating test; backend affected specs green; OpenAPI no-diff.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Update the SDD ledger** at `.superpowers/sdd/progress.md` with the branch outcome and PR link.

---

## Self-Review Notes (author)

- **Spec coverage:** hooks (§Components 1 → Task 2), UpgradePrompt (§2 → Task 4), FeatureGate (§3 → Task 5), max_active_trips proof (§4 → Task 6 + planner Task 7), 403 safety net (§5 → Tasks 6+7), refresh (§6 → Task 7), tier derivation from catalog (decision 3 → Task 1), testing (§Testing → per-task + Task 8). All covered.
- **Ships-dark / launch-mode** constraint reflected in Global Constraints + tests drive non-null limits explicitly.
- **Type consistency:** `USERS_ME_QUERY_KEY`, `useEntitlements`/`useFeature`/`useLimit`, `UpgradePromptProps.capability` discriminated union, `countOpenOwnedTrips`, `isFeatureLimitError`, `tierLabel`, `upgradeTierForFeature`/`upgradeTierForLimit` names are used identically across tasks.
- **Out of scope (deferred to Sub-project 2/3):** gating any feature other than `max_active_trips`, wiring `<FeatureGate>` to real toggles, the mobile client, removing the launch-mode seed.
