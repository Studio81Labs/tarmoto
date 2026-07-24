# Companion Feature Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the shipped entitlement primitives (`useFeature`/`useLimit`/`<UpgradePrompt>`) to the three companion-gateable features: `gpx_export`, `max_trip_collaborators`, and the road-quality zoom cap (`road_quality_max_zoom`).

**Architecture:** Reuse the Sub-project 1 primitives — no new gating infra. `gpx_export` locks the GPX export controls in place (CSV stays free) and opens the upgrade modal. `max_trip_collaborators` gates the invite action in the collaborate modal (owner-scoped, count-based, with a 403 safety net). `road_quality_max_zoom` clamps the quality overlay layer's `maxzoom` at the single `MapCanvas` choke point and opens the upgrade modal (one-shot) when a free rider zooms the overlay past the cap on the explore map.

**Tech Stack:** TypeScript strict, Next.js companion, `@tanstack/react-query`, `@tarmoto/shared` catalog, MapLibre GL, Vitest + `@testing-library/react`, ICU-MessageFormat i18n.

## Global Constraints

- **TypeScript strict everywhere.** No `any`; use shared/generated types.
- **Companion style:** double quotes, no `.js` import suffixes, `@/` path aliases.
- **i18n typed `t()`:** every new user-facing string MUST first be added to the English catalog under `apps/companion/src/i18n/locales/en/<module>.ts` as a flat `"Source string": "Source string"` entry, or `t("...")` is a compile error. Interpolation is ICU: `t("{used} of {max}", { used, max })`. A key must appear **exactly once** across all catalog modules (`duplicate-keys.test.ts` fails on dupes) — reuse an existing key rather than re-adding.
- **Client components use `useTranslation()` from `@/i18n/I18nProvider`, NOT a direct `t` import** — an ESLint `no-restricted-syntax` rule bans importing `t`/`translate`/`tDynamic` in `"use client"` modules. All three target files are already `"use client"` and already use `useTranslation()`.
- **ESLint i18n guard** flags raw string literals on `label|title|alt|placeholder|aria-label|ariaLabel` props, on raw JSX text, and in `set*Error`/`*Message` setters — wrap all new copy in `t()`. Run eslint on every touched file.
- **Companion CI typechecks test files** — run `pnpm --filter @tarmoto/companion exec tsc --noEmit` after editing tests.
- **Ships dark:** `gpx_export`, `max_trip_collaborators`, `road_quality_max_zoom` are all seeded permissive in launch mode, so the gates are inert in prod. Tests MUST drive each gate with an explicit off/finite value, never prod data.
- **Fail closed on unknown entitlement state** (the Sub-project 1 rule): while `useFeature`/`useLimit` are unresolved (`isLoading` / not `isSuccess`) or errored, treat the feature as locked / the rider as possibly at cap — disable the control, never flash the free/paid action.

## Catalog values (from `packages/shared/src/feature-flags.ts`, verbatim)

- `gpx_export`: `kind: "toggle"`, `default: false`, `tiers: PRO_AND_UP` (free off, pro/premium on). Capability shape: `{ feature: "gpx_export" }`.
- `max_trip_collaborators`: `kind: "limit"`, `default: 0`, `tiers: { free: 0, pro: 5, premium: null }` (premium unlimited). Capability: `{ limit: "max_trip_collaborators", resolvedLimit }`.
- `road_quality_max_zoom`: `kind: "limit"`, `default: 12`, `tiers: { free: 12, pro: null, premium: null }` (pro/premium unlimited → the source ceiling z18). Capability: `{ limit: "road_quality_max_zoom", resolvedLimit }`.

## Primitives that already exist (Sub-project 1 — do not rebuild)

- `useEntitlements(): { tier, features, limits, isLoading, isError, isSuccess }`, `useFeature(key): { enabled, isLoading }`, `useLimit(key): { limit, isLoading, isError, isSuccess }` — from `@/hooks`.
- `<UpgradePrompt>` — `apps/companion/src/components/entitlements/UpgradePrompt.tsx`. Props: `capability` (`{ feature: ToggleFeatureKey } | { limit: LimitFeatureKey; resolvedLimit: number | null }`), `currentTier: SubscriptionTier`, `message: string`, `variant: "inline" | "modal"`, `onClose?`, `suppressUpgrade?: boolean`.
- `parseFeatureLimitError(err): { feature, limit, current } | null`, `tierLabel(tier)` — from `@/lib/entitlements`.

---

## File Structure

**Create:**

- `apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.test.tsx`
- `apps/companion/src/components/TripExportButton.test.tsx`
- `apps/companion/src/lib/map-entitlements.ts` — `resolveQualityMaxZoom` pure helper.
- `apps/companion/src/lib/map-entitlements.test.ts`

**Modify:**

- `apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.tsx` — gate GPX item.
- `apps/companion/src/components/TripExportButton.tsx` — gate GPX button.
- `apps/companion/src/components/TripCollaborateModal.tsx` — gate invite (`PeopleTab`).
- `apps/companion/src/components/TripCollaborateModal.collab.test.tsx` — collaborator-gate tests.
- `apps/companion/src/components/map/MapCanvas.tsx` — clamp quality layer maxzoom.
- `apps/companion/src/components/map/MapCanvas.test.tsx` — clamp tests.
- `apps/companion/src/app/explore/_components/QualityMap.tsx` — zoom-past-cap modal.
- `apps/companion/src/i18n/locales/en/common.ts`, `.../rides.ts`, `.../map.ts` — catalog keys.

---

## Task 1: Gate `gpx_export` on the two GPX export controls

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.tsx`
- Modify: `apps/companion/src/components/TripExportButton.tsx`
- Modify: `apps/companion/src/i18n/locales/en/rides.ts`, `.../common.ts`
- Test: `apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.test.tsx` (create), `apps/companion/src/components/TripExportButton.test.tsx` (create)

**Interfaces:**

- Consumes: `useFeature`, `useEntitlements` from `@/hooks`; `UpgradePrompt` from `@/components/entitlements/UpgradePrompt`; `useTranslation` (already imported in both files).
- Produces: no new exports (behavioral).

- [ ] **Step 1: Add the one new catalog key.** Both components share the same
      new upgrade-message string, and a catalog key must live in exactly one
      module — so add it to `apps/companion/src/i18n/locales/en/common.ts` (flat
      entry, keep the file's ordering):

```ts
  "GPX export is a Pro feature.": "GPX export is a Pro feature.",
```

The `"GPX (tracks)"` key already exists in `rides.ts` and `"Export GPX"` already
exists in `common.ts` — reuse both, do NOT re-add. `"GPX export is a Pro
feature."` is the only new key for this task.

- [ ] **Step 2: Write the failing test** `apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useFeatureMock = vi.fn();
const useEntitlementsMock = vi.fn();
vi.mock("@/hooks", () => ({
  useFeature: (k: string) => useFeatureMock(k),
  useEntitlements: () => useEntitlementsMock(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { RideExportMenu } from "./RideExportMenu";

describe("RideExportMenu — gpx_export gate", () => {
  beforeEach(() => {
    useFeatureMock.mockReset();
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
  });

  it("exports GPX normally when the feature is enabled", async () => {
    useFeatureMock.mockReturnValue({ enabled: true, isLoading: false });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /GPX/i }));
    expect(onExport).toHaveBeenCalledWith("gpx");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the upgrade modal and does NOT export GPX when the feature is off", async () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: false });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /GPX/i }));
    expect(onExport).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("keeps CSV export free regardless of the GPX gate", async () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: false });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /CSV/i }));
    expect(onExport).toHaveBeenCalledWith("csv");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/app/(dashboard)/rides/_components/RideExportMenu.test.tsx"`
Expected: FAIL — GPX click still calls `onExport("gpx")`, no dialog.

- [ ] **Step 4: Implement the gate in `RideExportMenu.tsx`.**

4a. Add imports at the top (after the existing imports):

```ts
import { useFeature, useEntitlements } from "@/hooks";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
```

4b. Inside the component, after `const t = useTranslation();`, add:

```ts
const { enabled: gpxEnabled } = useFeature("gpx_export");
const { tier } = useEntitlements();
const [upgradeOpen, setUpgradeOpen] = useState(false);
```

(`useState` is already imported alongside `useTranslation` — confirm; if not, add it to the `react` import.)

4c. Change the GPX menu item's `onClick` (the button at ~lines 82-90) so that when the feature is off it opens the modal instead of exporting:

```tsx
<button
  type="button"
  role="menuitem"
  onClick={() => {
    if (!gpxEnabled) {
      setOpen(false);
      setUpgradeOpen(true);
      return;
    }
    void handleExport("gpx");
  }}
  disabled={busy !== null}
  className="w-full border-t border-line px-3 py-2 text-left text-sm text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
>
  {t("GPX (tracks)")}
</button>
```

(Leave the CSV button unchanged. Keep the exact original className.)

4d. Render the modal once at the end of the returned JSX (inside the component's root fragment/element):

```tsx
{
  upgradeOpen && tier ? (
    <UpgradePrompt
      variant="modal"
      capability={{ feature: "gpx_export" }}
      currentTier={tier}
      message={t("GPX export is a Pro feature.")}
      onClose={() => setUpgradeOpen(false)}
    />
  ) : null;
}
```

If the component currently returns a single `<div>`, wrap the return in a fragment so the modal is a sibling.

- [ ] **Step 5: Write + run the TripExportButton test** `apps/companion/src/components/TripExportButton.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useFeatureMock = vi.fn();
const useEntitlementsMock = vi.fn();
vi.mock("@/hooks", () => ({
  useFeature: (k: string) => useFeatureMock(k),
  useEntitlements: () => useEntitlementsMock(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// The GPX generator + download side effects — stub so the test asserts gating,
// not file output. Match the real import in TripExportButton.tsx.
vi.mock("@/lib/trip-export", () => ({
  tripToGpx: vi.fn(() => "<gpx/>"),
  tripFileName: vi.fn(() => "trip.gpx"),
}));

import { TripExportButton } from "./TripExportButton";

const trip = { id: "t1", name: "Alps", status: "planned" } as never;

describe("TripExportButton — gpx_export gate", () => {
  beforeEach(() => {
    useFeatureMock.mockReset();
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
  });

  it("opens the upgrade modal instead of exporting when gpx_export is off", async () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: false });
    render(<TripExportButton trip={trip} />);
    await userEvent.click(screen.getByRole("button", { name: /Export GPX/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("exports normally when gpx_export is enabled", async () => {
    useFeatureMock.mockReturnValue({ enabled: true, isLoading: false });
    render(<TripExportButton trip={trip} />);
    await userEvent.click(screen.getByRole("button", { name: /Export GPX/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/components/TripExportButton.test.tsx"` (RED), then implement, then GREEN.

- [ ] **Step 6: Implement the gate in `TripExportButton.tsx`.**

6a. Imports:

```ts
import { useState } from "react";
import { useFeature, useEntitlements } from "@/hooks";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
```

(Confirm `useState` isn't already imported.)

6b. In the component, after `const t = useTranslation();`:

```ts
const { enabled: gpxEnabled } = useFeature("gpx_export");
const { tier } = useEntitlements();
const [upgradeOpen, setUpgradeOpen] = useState(false);
```

6c. Change `handleGpx` to gate at the top:

```ts
const handleGpx = () => {
  if (!gpxEnabled) {
    setUpgradeOpen(true);
    return;
  }
  if (!trip) return;
  // ...existing GPX build + download body unchanged...
};
```

(Keep the rest of `handleGpx` exactly as-is below the gate. Note: the button's existing `disabled={!trip}` stays — a locked GPX is still clickable-to-upgrade only when a trip exists; that's fine because the whole point is a paid trip export.)

6d. Wrap the return in a fragment and render the modal:

```tsx
return (
  <>
    <Tooltip content={t("Export GPX")} placement="below">
      {/* ...existing Button unchanged... */}
    </Tooltip>
    {upgradeOpen && tier ? (
      <UpgradePrompt
        variant="modal"
        capability={{ feature: "gpx_export" }}
        currentTier={tier}
        message={t("GPX export is a Pro feature.")}
        onClose={() => setUpgradeOpen(false)}
      />
    ) : null}
  </>
);
```

- [ ] **Step 7: Run both tests + tsc + eslint**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/app/(dashboard)/rides/_components/RideExportMenu.test.tsx" "src/components/TripExportButton.test.tsx"`
Expected: PASS.
Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec eslint "src/app/(dashboard)/rides/_components/RideExportMenu.tsx" "src/components/TripExportButton.tsx"`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add "apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.tsx" "apps/companion/src/app/(dashboard)/rides/_components/RideExportMenu.test.tsx" apps/companion/src/components/TripExportButton.tsx apps/companion/src/components/TripExportButton.test.tsx apps/companion/src/i18n/locales/en/common.ts
git commit -m "feat(companion): gate GPX export behind the gpx_export flag (CSV stays free)"
```

---

## Task 2: Gate `max_trip_collaborators` on the invite action

**Files:**

- Modify: `apps/companion/src/components/TripCollaborateModal.tsx`
- Modify: `apps/companion/src/i18n/locales/en/common.ts`
- Test: `apps/companion/src/components/TripCollaborateModal.collab.test.tsx`

**Interfaces:**

- Consumes: `useEntitlements`, `useLimit` from `@/hooks`; `UpgradePrompt` from `@/components/entitlements/UpgradePrompt`; `parseFeatureLimitError`, `tierLabel` from `@/lib/entitlements`.
- Produces: behavioral (invite gate in `PeopleTab`).

**Design notes for the implementer:**

- The backend limit "collaborators per trip, excluding the owner" is measured against the OWNER's tier. The modal's `useEntitlements` gives the CURRENT user's tier, which is authoritative ONLY when the current user is the owner. So: proactively gate (block + counter + CTA) **only when `isOwner`**; for an editor inviting, do not proactively block (their tier isn't the cap's) — rely on the 403 safety net with a suppressed CTA.
- Roster count excluding the owner: `collaborators.members.filter((m) => m.role !== "owner").length + collaborators.invites.length`. The existing `total` (line ~678) includes the owner — do NOT reuse it for the cap comparison.

- [ ] **Step 1: Add catalog keys** to `apps/companion/src/i18n/locales/en/common.ts`:

```ts
  "{count} of {max} collaborators": "{count} of {max} collaborators",
  "You've reached the collaborator limit for this trip.":
    "You've reached the collaborator limit for this trip.",
  "The trip owner has reached their collaborator limit.":
    "The trip owner has reached their collaborator limit.",
```

- [ ] **Step 2: Write the failing tests** — append to `apps/companion/src/components/TripCollaborateModal.collab.test.tsx`. First extend its `@/hooks` handling: the file does not currently mock `@/hooks`, so add a mock near the top-of-file mocks (mirror the collab test's `vi.hoisted`/`vi.mock` style):

```tsx
const useLimitMock = vi.fn(() => ({
  limit: null as number | null,
  isLoading: false,
  isError: false,
  isSuccess: true,
}));
const useEntitlementsMock = vi.fn(() => ({ tier: "free" }));
vi.mock("@/hooks", () => ({
  useLimit: () => useLimitMock(),
  useEntitlements: () => useEntitlementsMock(),
}));
```

Reset them in the existing `beforeEach` (default: unlimited cap, free tier). Then add:

```tsx
it("blocks the invite and shows the counter when the OWNER is at the collaborator cap", async () => {
  useLimitMock.mockReturnValue({
    limit: 1,
    isLoading: false,
    isError: false,
    isSuccess: true,
  });
  hoisted.listMembers.mockReset().mockResolvedValue({
    data: {
      members: [
        {
          user_id: "owner-1",
          display_name: "Owner",
          email: "o@example.com",
          avatar_url: null,
          role: "owner",
          joined_at: "2026-07-02T10:00:00Z",
          state: "joined",
        },
        {
          user_id: "member-1",
          display_name: "Eve",
          email: "eve@example.com",
          avatar_url: null,
          role: "editor",
          joined_at: "2026-07-02T10:00:00Z",
          state: "joined",
        },
      ],
      invites: [],
    },
  });
  // ...render the modal open, as the owner (currentUserId="owner-1" ownerId="owner-1"),
  //    click the People tab (follow the existing collab-test render+tab pattern)...
  // 1 non-owner collaborator, cap 1 → at limit.
  expect(await screen.findByText(/1 of 1 collaborators/i)).toBeInTheDocument();
  const invite = screen.getByRole("button", { name: /^invite$/i });
  expect(invite).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Upgrade to Pro/i }),
  ).toBeInTheDocument();
});

it("does not proactively block an EDITOR inviting (owner-scoped cap), relies on the 403", async () => {
  useLimitMock.mockReturnValue({
    limit: 0,
    isLoading: false,
    isError: false,
    isSuccess: true,
  });
  // ...render as an EDITOR (currentUserId = an editor member id, ownerId = someone else)...
  // The editor's own tier isn't the cap's — invite stays enabled proactively.
  const invite = screen.getByRole("button", { name: /^invite$/i });
  expect(invite).not.toBeDisabled();
});

it("routes a FEATURE_LIMIT_EXCEEDED invite 403 to the upgrade modal", async () => {
  // Import ApiError + FEATURE_LIMIT_EXCEEDED at the top of the test file.
  hoisted.invite.mockRejectedValueOnce(
    new ApiError("limit", 403, {
      code: FEATURE_LIMIT_EXCEEDED,
      feature: "max_trip_collaborators",
      limit: 5,
      current: 5,
    }),
  );
  // ...render as owner, People tab, fill an email, click Invite...
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});
```

(Fill the `// ...` render/tab/fill steps by copying the existing invite-success test's exact render props + interactions in this same file.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/components/TripCollaborateModal.collab.test.tsx"`
Expected: FAIL — no counter, invite enabled, no dialog on 403.

- [ ] **Step 4: Implement the gate in `TripCollaborateModal.tsx`.**

4a. Imports:

```ts
import { useEntitlements, useLimit } from "@/hooks";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
import { parseFeatureLimitError, tierLabel } from "@/lib/entitlements";
```

4b. `PeopleTab` receives `isOwner`/`callerRole`/`collaborators` already. Inside `PeopleTab`, after the existing `const total = ...`, add the cap state:

```ts
const { tier } = useEntitlements();
const { limit: collabLimit, isSuccess: limitResolved } = useLimit(
  "max_trip_collaborators",
);
const nonOwnerCount = collaborators
  ? collaborators.members.filter((m) => m.role !== "owner").length +
    collaborators.invites.length
  : 0;
// Proactive gate is authoritative only for the OWNER (the cap is the owner's).
// Fail closed: an unresolved cap blocks the owner too.
const atCollaboratorCap =
  isOwner &&
  (!limitResolved || (collabLimit !== null && nonOwnerCount >= collabLimit));
const [upgradeErr, setUpgradeErr] = useState<number | null>(null);
```

4c. Disable the Invite button and add the counter + inline prompt. Change the button's `disabled`:

```tsx
              disabled={inviting || !email.trim() || atCollaboratorCap}
```

And, inside the `{canInvite && (...)}` block near the invite form, render the counter + inline prompt when at cap:

```tsx
{
  atCollaboratorCap && tier && collabLimit !== null ? (
    <div className="mt-3">
      <p className="mb-2 text-[12.5px] text-ink/70">
        {t("{count} of {max} collaborators", {
          count: nonOwnerCount,
          max: collabLimit,
        })}
      </p>
      <UpgradePrompt
        variant="inline"
        capability={{
          limit: "max_trip_collaborators",
          resolvedLimit: collabLimit,
        }}
        currentTier={tier}
        message={t("You've reached the collaborator limit for this trip.")}
      />
    </div>
  ) : null;
}
```

4d. Add the 403 safety net. In `handleInvite`'s `catch`, before `setError(describeError(err, t))`, branch on the limit error:

```ts
    } catch (err) {
      const limitError = parseFeatureLimitError(err);
      if (limitError) {
        setUpgradeErr(limitError.limit);
      } else {
        setError(describeError(err, t));
      }
    } finally {
      setInviting(false);
    }
```

4e. Render the modal from the 403 path once (inside `PeopleTab`'s returned JSX). Suppress the CTA when the caller isn't the owner (the cap is the owner's, so upgrading an editor's plan can't lift it):

```tsx
{
  upgradeErr !== null && tier ? (
    <UpgradePrompt
      variant="modal"
      capability={{
        limit: "max_trip_collaborators",
        resolvedLimit: upgradeErr,
      }}
      currentTier={tier}
      suppressUpgrade={!isOwner}
      message={
        isOwner
          ? t("You've reached the collaborator limit for this trip.")
          : t("The trip owner has reached their collaborator limit.")
      }
      onClose={() => setUpgradeErr(null)}
    />
  ) : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/components/TripCollaborateModal.collab.test.tsx"`
Expected: PASS.

- [ ] **Step 6: tsc + eslint**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec eslint "src/components/TripCollaborateModal.tsx"`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/companion/src/components/TripCollaborateModal.tsx apps/companion/src/components/TripCollaborateModal.collab.test.tsx apps/companion/src/i18n/locales/en/common.ts
git commit -m "feat(companion): gate trip-collaborator invites on max_trip_collaborators (owner-scoped + 403 safety net)"
```

---

## Task 3: Clamp the road-quality overlay maxzoom on `road_quality_max_zoom`

**Files:**

- Create: `apps/companion/src/lib/map-entitlements.ts`, `apps/companion/src/lib/map-entitlements.test.ts`
- Modify: `apps/companion/src/components/map/MapCanvas.tsx`
- Test: `apps/companion/src/components/map/MapCanvas.test.tsx`

**Interfaces:**

- Consumes: `useLimit` from `@/hooks`; MapLibre map instance in `MapCanvas`.
- Produces: `resolveQualityMaxZoom(limit: number | null, isResolved: boolean): number` from `@/lib/map-entitlements` (used again in Task 4).

- [ ] **Step 1: Write the helper test** `apps/companion/src/lib/map-entitlements.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  resolveQualityMaxZoom,
  QUALITY_OVERLAY_CEILING_ZOOM,
  QUALITY_OVERLAY_FLOOR_ZOOM,
} from "./map-entitlements";

describe("resolveQualityMaxZoom", () => {
  it("uses the free floor while the cap is unresolved (fail closed)", () => {
    expect(resolveQualityMaxZoom(null, false)).toBe(QUALITY_OVERLAY_FLOOR_ZOOM);
    expect(resolveQualityMaxZoom(12, false)).toBe(QUALITY_OVERLAY_FLOOR_ZOOM);
  });
  it("maps a resolved unlimited cap (null) to the source ceiling", () => {
    expect(resolveQualityMaxZoom(null, true)).toBe(
      QUALITY_OVERLAY_CEILING_ZOOM,
    );
  });
  it("returns a resolved finite cap as-is", () => {
    expect(resolveQualityMaxZoom(12, true)).toBe(12);
  });
});
```

- [ ] **Step 2: Run it (RED), then implement** `apps/companion/src/lib/map-entitlements.ts`:

```ts
/** The road-quality overlay never renders above this zoom (the vector source's
 *  over-zoom ceiling, mirroring MapCanvas's source maxzoom). */
export const QUALITY_OVERLAY_CEILING_ZOOM = 18;
/** Fail-closed cap while entitlements are unresolved (the free-tier default for
 *  `road_quality_max_zoom`). */
export const QUALITY_OVERLAY_FLOOR_ZOOM = 12;

/**
 * The maxzoom to apply to the road-quality overlay layer, from a resolved
 * `road_quality_max_zoom` limit. `null` = unlimited (pro/premium) → the source
 * ceiling. Until the cap RESOLVES (`isResolved` false — loading / error /
 * pre-auth) fail closed to the free floor rather than render full detail we
 * can't confirm entitlement for.
 */
export function resolveQualityMaxZoom(
  limit: number | null,
  isResolved: boolean,
): number {
  if (!isResolved) return QUALITY_OVERLAY_FLOOR_ZOOM;
  return limit === null ? QUALITY_OVERLAY_CEILING_ZOOM : limit;
}
```

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/lib/map-entitlements.test.ts"` → GREEN.

- [ ] **Step 3: Write the failing MapCanvas clamp test.** Extend `apps/companion/src/components/map/MapCanvas.test.tsx`. First mock `@/hooks` `useLimit` (add near the top-of-file mocks) and add `setLayerZoomRange` to the `mapStub` (the existing stub lacks it):

```tsx
const useLimitMock = vi.fn(() => ({
  limit: null as number | null,
  isLoading: false,
  isError: false,
  isSuccess: true,
}));
vi.mock("@/hooks", () => ({ useLimit: () => useLimitMock() }));
```

Add to `mapStub` (the object at ~lines 12-32): `setLayerZoomRange: vi.fn(),`. Then add:

```tsx
it("adds the quality overlay layer with the free maxzoom cap when limited", async () => {
  useLimitMock.mockReturnValue({
    limit: 12,
    isLoading: false,
    isError: false,
    isSuccess: true,
  });
  render(
    <MapCanvas
      center={{ lng: 0, lat: 0 }}
      zoom={7}
      showQuality
      showSurface={false}
    />,
  );
  await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
  act(() => {
    for (const h of loadHandlers) h();
  });
  expect(mapStub.addLayer).toHaveBeenCalledWith(
    expect.objectContaining({ id: TARMOTO_QUALITY_LAYER, maxzoom: 12 }),
  );
});

it("lifts the quality overlay cap for an unlimited (pro/premium) rider", async () => {
  useLimitMock.mockReturnValue({
    limit: null,
    isLoading: false,
    isError: false,
    isSuccess: true,
  });
  render(
    <MapCanvas
      center={{ lng: 0, lat: 0 }}
      zoom={7}
      showQuality
      showSurface={false}
    />,
  );
  await waitFor(() => expect(loadHandlers.length).toBeGreaterThan(0));
  act(() => {
    for (const h of loadHandlers) h();
  });
  expect(mapStub.addLayer).toHaveBeenCalledWith(
    expect.objectContaining({ id: TARMOTO_QUALITY_LAYER, maxzoom: 18 }),
  );
});
```

(Reset `useLimitMock` to the unlimited default in the existing `beforeEach`. Match the exact `MapCanvas` required props from the existing render calls in this file — the snippet's prop list may need `selectedSegmentId`/others; copy them from a sibling test render.)

- [ ] **Step 4: Run (RED), then implement the clamp in `MapCanvas.tsx`.**

4a. Import the helper + hook:

```ts
import { useLimit } from "@/hooks";
import { resolveQualityMaxZoom } from "@/lib/map-entitlements";
```

4b. In the component body (near the other hook calls like `useMapColorScheme`), resolve the cap:

```ts
const { limit: qualityZoomLimit, isSuccess: qualityZoomResolved } = useLimit(
  "road_quality_max_zoom",
);
const qualityMaxZoom = resolveQualityMaxZoom(
  qualityZoomLimit,
  qualityZoomResolved,
);
```

4c. In the `addLayer` call for `TARMOTO_QUALITY_LAYER` (~lines 332-358), add `maxzoom: qualityMaxZoom` alongside the existing `minzoom: TARMOTO_ROADS_MIN_ZOOM`. Because the layer is added inside the `load` handler (a closure), read the current value via a ref to avoid a stale capture — add a ref that tracks `qualityMaxZoom`:

```ts
const qualityMaxZoomRef = useRef(qualityMaxZoom);
qualityMaxZoomRef.current = qualityMaxZoom;
```

and use `maxzoom: qualityMaxZoomRef.current` in the `addLayer` spec.

4d. Apply cap changes at runtime (the cap resolves async, after the layer is added) with an effect:

```ts
useEffect(() => {
  const map = mapRef.current;
  if (!map || !map.getLayer(TARMOTO_QUALITY_LAYER)) return;
  map.setLayerZoomRange(
    TARMOTO_QUALITY_LAYER,
    TARMOTO_ROADS_MIN_ZOOM,
    qualityMaxZoom,
  );
}, [qualityMaxZoom]);
```

(`getLayer` guards the case where the layer isn't added yet — the initial `addLayer` already carried the cap via the ref.)

- [ ] **Step 5: Run the MapCanvas tests + tsc + eslint**

Run: `pnpm --filter @tarmoto/companion exec vitest run "src/components/map/MapCanvas.test.tsx" "src/lib/map-entitlements.test.ts"`
Expected: PASS (existing MapCanvas tests still green).
Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec eslint "src/components/map/MapCanvas.tsx" "src/lib/map-entitlements.ts"`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/lib/map-entitlements.ts apps/companion/src/lib/map-entitlements.test.ts apps/companion/src/components/map/MapCanvas.tsx apps/companion/src/components/map/MapCanvas.test.tsx
git commit -m "feat(companion): clamp road-quality overlay maxzoom on road_quality_max_zoom"
```

---

## Task 4: Upgrade modal when a free rider zooms the explore quality overlay past the cap

**Files:**

- Modify: `apps/companion/src/app/explore/_components/QualityMap.tsx`
- Modify: `apps/companion/src/i18n/locales/en/map.ts`
- Test: extend the QualityMap test if one exists; otherwise add a focused test (see Step 4).

**Interfaces:**

- Consumes: `useEntitlements`, `useLimit` from `@/hooks`; `resolveQualityMaxZoom` from `@/lib/map-entitlements` (Task 3); `UpgradePrompt` from `@/components/entitlements/UpgradePrompt`; the `showQuality` prop + `MapCanvas`'s `onViewChange` (fires on moveend with the current `zoom`).
- Produces: behavioral (one-shot modal on the explore map).

**Design note:** the clamp (Task 3) already stops the overlay rendering past the cap on ALL surfaces. This task adds the discovery nudge on the primary interactive surface only (explore's `QualityMap`) — NOT every quality map, to avoid scattering modals. Other quality consumers keep the silent clamp.

- [ ] **Step 1: Add the catalog key** to `apps/companion/src/i18n/locales/en/map.ts`:

```ts
  "Zoom in further for full road-quality detail with Pro.":
    "Zoom in further for full road-quality detail with Pro.",
```

- [ ] **Step 2: Determine the zoom source.** Read `QualityMap.tsx` around the `MapCanvas` render (~lines 1187-1198) and `readMapView` (~line 203). Use `MapCanvas`'s `onViewChange` prop to observe the current zoom (it fires with `{ zoom }` on moveend); if `QualityMap` already passes an `onViewChange`, extend that handler, otherwise add one.

- [ ] **Step 3: Implement the one-shot modal in `QualityMap.tsx`.**

3a. Imports:

```ts
import { useEntitlements, useLimit } from "@/hooks";
import { resolveQualityMaxZoom } from "@/lib/map-entitlements";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";
```

3b. In the component:

```ts
const { tier } = useEntitlements();
const { limit: qualityZoomLimit, isSuccess: qualityZoomResolved } = useLimit(
  "road_quality_max_zoom",
);
const qualityCapFinite = qualityZoomResolved && qualityZoomLimit !== null; // free tier
const qualityCap = resolveQualityMaxZoom(qualityZoomLimit, qualityZoomResolved);
const [zoomUpgradeOpen, setZoomUpgradeOpen] = useState(false);
const [zoomUpgradeDismissed, setZoomUpgradeDismissed] = useState(false);
```

3c. In the view/zoom handler (the `onViewChange` from `MapCanvas`), when the overlay is on, the cap is finite, the rider zoomed past it, and they haven't dismissed it this session — open the modal once:

```ts
// inside the onViewChange callback, given the new `zoom`:
if (
  showQuality &&
  qualityCapFinite &&
  zoom > qualityCap &&
  !zoomUpgradeDismissed
) {
  setZoomUpgradeOpen(true);
}
```

3d. Render the modal (one-shot dismiss):

```tsx
{
  zoomUpgradeOpen && tier ? (
    <UpgradePrompt
      variant="modal"
      capability={{
        limit: "road_quality_max_zoom",
        resolvedLimit: qualityZoomLimit,
      }}
      currentTier={tier}
      message={t("Zoom in further for full road-quality detail with Pro.")}
      onClose={() => {
        setZoomUpgradeOpen(false);
        setZoomUpgradeDismissed(true);
      }}
    />
  ) : null;
}
```

- [ ] **Step 4: Add a focused test.** If `QualityMap.test.tsx` exists, extend it; otherwise add `apps/companion/src/app/explore/_components/QualityMap.zoom-gate.test.tsx` mocking `@/hooks` (`useEntitlements`→`{tier:"free"}`, `useLimit`→`{limit:12,isSuccess:true}`) and `MapCanvas` (a stub that lets the test invoke `onViewChange({ zoom })`). Assert: overlay on + free cap 12 + `onViewChange({ zoom: 14 })` → dialog appears; dismiss → a second `onViewChange({ zoom: 15 })` does NOT reopen it. If mocking `MapCanvas`/QualityMap proves intractable (heavy map deps), extract the "should the zoom prompt open" decision into a tiny pure predicate in `map-entitlements.ts` (e.g. `shouldPromptQualityZoom({ showQuality, capFinite, zoom, cap, dismissed })`) and unit-test THAT directly, wiring the component to call it. Prefer the pure-predicate route if the render test is heavy — note which you chose in the report.

- [ ] **Step 5: Run tests + tsc + eslint**

Run the new test, then `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec eslint "src/app/explore/_components/QualityMap.tsx"`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/app/explore/_components/QualityMap.tsx apps/companion/src/i18n/locales/en/map.ts apps/companion/src/lib/map-entitlements.ts apps/companion/src/lib/map-entitlements.test.ts
git commit -m "feat(companion): upgrade modal when a free rider zooms explore road-quality past the cap"
```

---

## Task 5: Full validation + PR

**Files:** none (validation + PR only).

- [ ] **Step 1: Full companion suite**

Run: `pnpm --filter @tarmoto/companion test`
Expected: all pass, including the i18n `duplicate-keys.test.ts` and `eslintGuard.test.ts` (confirms no duplicate/uncataloged keys).

- [ ] **Step 2: Typecheck (test files included) + lint**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion lint`
Expected: no errors (pre-existing warnings in untouched files are fine).

- [ ] **Step 3: OpenAPI sanity (contract unchanged)**

Run: `pnpm openapi:gen` (or the repo's openapi gen script).
Expected: success, no generated diff — this change adds no DTO/endpoint. `git status` shows no `packages/openapi` changes.

- [ ] **Step 4: Request code review**

Use superpowers:requesting-code-review for the whole branch. Address findings; re-run Steps 1-3 after any fix.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --label companion --title "feat(companion): gate GPX export, trip collaborators, and road-quality zoom" --body "$(cat <<'EOF'
## Summary
Sub-project 2 of the client-consumption epic: wires the shipped entitlement primitives to the three companion-gateable features.

- **gpx_export** (toggle, pro+): the GPX export controls (`RideExportMenu` GPX item + `TripExportButton`) lock and open the upgrade modal when off; CSV export stays free.
- **max_trip_collaborators** (limit): the collaborate-modal invite action is gated — owner-scoped proactive block + "{count} of {max}" counter + inline prompt, with a `FEATURE_LIMIT_EXCEEDED` 403 safety net (CTA suppressed for non-owner editors).
- **road_quality_max_zoom** (limit): the road-quality overlay layer's maxzoom is clamped at the `MapCanvas` choke point (free z12 / pro+ z18); on the explore map, zooming past the cap opens the upgrade modal once.

## Contract / migration impact
None. No DTO/endpoint/migration changes. OpenAPI byte-identical.

## Ships dark
All three flags/limits are seeded permissive in launch mode, so the gates are inert in production until the seeds flip.

## Tests
Component/unit tests for each gate (GPX lock + CSV-free; collaborator owner-scoped block + counter + 403; zoom-clamp helper + MapCanvas layer maxzoom + explore one-shot modal); full companion suite green; OpenAPI no-diff.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Update the SDD ledger** at `.superpowers/sdd/progress.md` with the branch outcome + PR link.

---

## Self-Review Notes (author)

- **Spec coverage:** gpx_export (§Components 1 → Task 1), max_trip_collaborators (§2 → Task 2), road-quality clamp (§3 → Task 3) + zoom modal (§3 → Task 4), tests (§Testing → per-task + Task 5). All covered.
- **Owner-scoped collaborator cap** (the editor-can-invite subtlety the recon surfaced) is handled: proactive gate only when `isOwner`, `suppressUpgrade={!isOwner}` on the 403 path — reusing the Sub-project 1 owner-scoped pattern.
- **Roster count excludes the owner** (`role !== "owner"`), matching the backend "excluding the owner" definition — the existing `total` includes the owner and is NOT reused for the cap.
- **Clamp centralized at MapCanvas** (can't leak across quality surfaces); modal scoped to the explore surface only (no scattered modals). `resolveQualityMaxZoom` is the shared fail-closed helper (unknown→12, null→18, finite→as-is).
- **Type/name consistency:** `resolveQualityMaxZoom`, `QUALITY_OVERLAY_CEILING_ZOOM`/`FLOOR_ZOOM`, `atCollaboratorCap`, `nonOwnerCount`, `qualityMaxZoom`, capability shapes (`{ feature }` vs `{ limit, resolvedLimit }`) are used identically across tasks.
- **Ships-dark** reflected in constraints + every test drives explicit off/finite values.
- **Out of scope (deferred):** mobile (Sub-project 3); all mobile-only keys; the redundant `road_quality_full_zoom` toggle gate (subsumed by the limit); modal on non-explore quality maps.
