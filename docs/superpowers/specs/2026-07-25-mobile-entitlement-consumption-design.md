# Mobile Entitlement Consumption — Design

**Sub-project 3 of the "client consumption of tier entitlements" epic** (companion = Sub-project 1 #1078 + Sub-project 2 #1082, both merged). This wires the React Native app (`apps/mobile`) to consume the already-served entitlement snapshot and gate its surfaces, mirroring the companion — adapted to mobile's Zustand-not-react-query architecture and its lack of an in-app billing surface.

## Goal

Read the server-resolved entitlement snapshot (`subscription_tier` / `features` / `limits`) that already lands in the mobile auth store, and gate the four gateable mobile surfaces on it — shipping DARK behind the existing launch-mode seeds so behaviour is byte-identical until monetization go-live.

## Scope decisions (approved)

- **Full parity**: foundation hooks + `<UpgradePrompt>` + all gates.
- **Upgrade UX = IAP-ready seam, not built**: mobile has no billing screen and IAP is a separate payments project (store product config + a receipt-validation backend + Stripe reconciliation — out of scope, blocked on store credentials). The `<UpgradePrompt>` upgrade action is a single well-defined callback seam; for now it is informational (benefits copy / neutral acknowledge), and a future IAP PR wires the purchase into that seam. No deep-link to web (Apple/Google forbid external-payment links for digital subscriptions).

## Current state (from exploration)

Entitlement gating is **not** started on mobile, but the data and plumbing are present:

- The Zustand auth store (`src/stores/index.ts`) holds the full `user` (`Schemas["UserResponseDto"]`), which **retains** `subscription_tier` / `features` / `limits` — set by `setUser`, refreshed on launch by `services/authBootstrap.ts`, never read for gating.
- Transport: same generated `@tarmoto/openapi-client` (`openapi-fetch`) + `Schemas[]` aliases (`src/types/index.ts`) as the web app. Errors surface as `ApiError` (`src/services/api.ts:117`) with `.status` and `.body`.
- `@tarmoto/shared` entitlement helpers (`isFeatureEnabled`, `getFeatureLimit`, `upgradeTierForFeature`, `upgradeTierForLimit`, `FEATURE_LIMIT_EXCEEDED`) are importable, currently unused.
- Typed i18n exists (`src/i18n/`, `useTranslation()`, `translate()`, `EnglishMessageKey`, `src/i18n/locales/en.ts`); an ESLint guard requires user-facing strings go through `t()`.
- Authenticated riders resolve entitlements from the `authBootstrap`-refreshed `/users/me` snapshot (no react-query needed). **Correction (PR #1086):** the map tab is NOT auth-gated and the backend quality tiles are public, so signed-out riders ARE real map users. The road-quality overlay therefore mirrors the companion's anonymous path — a confirmed-anonymous rider (settled bootstrap, no user) resolves `road_quality_max_zoom` from the public `GET /config/limits` global-override map (`useRoadQualityZoomCap` in `MapScreen.entitlement.ts`), so the dark-launch `NULL` seed renders unlimited (z22) for them and a post-launch anonymous rider clamps to the free cap. Other gates (GPX) stay authed-only.

### Gateable surfaces (all exist, ungated)

| Surface                    | File(s)                                                                                                                                                                          | Key                             | Enforcement                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| Road-quality overlay zoom  | `screens/MapScreen.tsx` (MapLibre `<VectorSource>`/`<Layer>`)                                                                                                                    | `road_quality_max_zoom` (limit) | **Client-only** (the overlay clamp)                                       |
| GPX export (single + bulk) | `screens/RideDetailScreen.tsx`, `screens/SettingsScreen.tsx` (`BulkExportCard`) → `api.exportRideGpx` / `api.exportAllRidesGpx` (`GET /rides/{id}/gpx`, `GET /rides/export.gpx`) | `gpx_export` (toggle)           | **Server-enforced** (backend 403s a non-entitled rider); client gate = UX |
| Trip join                  | ~~`screens/JoinTripScreen.tsx`~~ — **gate removed post-review** (see correction below)                                                                                           | ~~`max_trip_collaborators`~~    | **No mobile gate** — endpoint can't emit the cap                          |

Mobile `MapScreen` has **no** road-segment tap-for-detail (only overlay toggles + fun-zone press), so the companion's Explore/planner selection-gate work does **not** apply — the road-quality gate is purely the maxzoom clamp.

> **Correction (post-review, PR #1086):** the trip-join gate below was **dropped**. `POST /trips/{id}/join` (mobile's `api.joinTrip`) consumes an **already-reserved** personal invite and never runs a collaborator-limit check — the `max_trip_collaborators` cap is enforced at invite **creation** (`TripsService.invite`) and on the public share-link join (`POST /trip-shares/{token}/join`), **neither of which mobile calls**. So that endpoint can never emit `FEATURE_LIMIT_EXCEEDED`; JoinTripScreen uses plain generic error handling, and the `isFeatureLimitError` helper was removed (no mobile flow emits the cap). §6, the join acceptance criterion, and the `isFeatureLimitError` references below are superseded by this note.

**Global constraints (verbatim values):**

- `road_quality_max_zoom`: free = 12, pro/premium = `null` (unlimited). Fail-closed fallback = free cap 12. Unlimited → the platform's overlay source ceiling.
- The limit feeds the overlay layer's `maxzoom` DIRECTLY (overlay stops past the cap; no `+1`) — same rule as companion Sub-project 2.
- Ships DARK: seeds `limit_states(max_trip_collaborators|road_quality_max_zoom, NULL)` (migration 1818) + boolean force-on for `gpx_export` mean every gate is inert until go-live. Under current data mobile is byte-identical.
- No backend changes (enforcement already shipped in #1082). No new API endpoints.
- All new user-facing copy = typed `EnglishMessageKey` catalog entries.

---

## Design

### 1. Shared hoist — the pure overlay-cap math

`resolveQualityLayerMaxZoom` currently lives in `apps/companion/src/lib/map-entitlements.ts` with `QUALITY_OVERLAY_FREE_CAP_ZOOM = 12` and a companion-specific unlimited ceiling `18`. The clamp logic (feed limit directly; fail-closed to the free cap while unresolved; preserve a stricter known finite cap) is platform-agnostic and must not drift between companion and mobile — but the **unlimited ceiling is platform-specific** (the vector source's real max: companion 18; mobile confirms during planning — likely 18, with the current `maxzoom={22}` on the `<VectorSource>` just a loose over-zoom setting).

**Hoist into `@tarmoto/shared`** (new `src/quality-zoom.ts`, exported from the package index):

```ts
export const QUALITY_OVERLAY_FREE_CAP_ZOOM = 12;

/** Map a resolved `road_quality_max_zoom` limit → the overlay layer's exclusive
 *  maxzoom. Feeds the limit DIRECTLY (overlay stops past the cap). `null` =
 *  unlimited → the caller's platform `sourceCeiling`. Unresolved → fail closed
 *  to the free cap, but never widen a stricter finite cap already known. */
export function resolveQualityLayerMaxZoom(
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

Companion refactors its `map-entitlements.ts` to re-export/delegate to the shared function, passing its ceiling (18) — keeping its existing local wrappers (`shouldPromptQualityZoom`, `canSelectRoadAtZoom`, `resolveQualityLayerMaxZoom(limit, resolved)` two-arg) intact so **no companion behaviour changes and no companion call-site edits are needed** beyond the internal delegation. (Companion's `QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM = 18` stays companion-local as the value it passes in.)

Rationale: one definition of the free cap + clamp rule; each platform owns its source ceiling.

### 2. Foundation — entitlement hooks (`src/hooks/useEntitlements.ts`)

Read the snapshot from the auth store — **no new fetch, no react-query** (mobile has none; the snapshot is already cached and refreshed by `authBootstrap`):

```ts
export function useEntitlements(): {
  tier: SubscriptionTier | null;
  features: User["features"] | null;
  limits: User["limits"] | null;
  isResolved: boolean; // a user is loaded (authenticated)
} {
  const user = useAuthStore((s) => s.user);
  return {
    tier: user?.subscription_tier ?? null,
    features: user?.features ?? null,
    limits: user?.limits ?? null,
    isResolved: user != null,
  };
}

export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isResolved: boolean;
};
export function useLimit(key: LimitFeatureKey): {
  limit: number | null;
  isResolved: boolean;
};
```

- `useFeature` → `features ? isFeatureEnabled(features, key) : false`, `isResolved = features != null`.
- `useLimit` → `limits ? getFeatureLimit(limits, key) : null` (missing-key falls back to the shared restrictive default per `getFeatureLimit`), `isResolved = limits != null`.
- **Fail closed** on `!isResolved`. For the authed gates the store either has a user (resolved) or is mid-hydration/logged out (fail closed). The road-quality overlay additionally has the anonymous path above (PR #1086): a confirmed-anonymous rider resolves via `/config/limits`, failing closed to the free cap while that fetch is pending/failed (offline).

Plus `src/lib/entitlements.ts`:

- `isFeatureLimitError(err): boolean` — `err instanceof ApiError && err.status === 403 && (err.body as { code?: string })?.code === FEATURE_LIMIT_EXCEEDED`.
- `tierLabel(tier): string` — localized tier display (Free/Pro/Premium) via the catalog.

### 3. `<UpgradePrompt>` (`src/components/entitlements/UpgradePrompt.tsx`)

Port the companion component to RN (`Modal` + the mobile UI kit + `useTranslation`). Same `capability` union (`{feature}` | `{limit, resolvedLimit}`), `currentTier`, `message`, `suppressUpgrade`. Target tier via `upgradeTierForFeature`/`upgradeTierForLimit`.

- `target === null` → neutral "Limit reached" (no upgrade lifts it — override/top-tier/owner-scoped); else "Upgrade required".
- **Upgrade action = the IAP seam**: an `onUpgrade?: () => void` prop. When absent (the default this sub-project ships), the CTA renders as a disabled/"coming soon" affordance or is omitted, and the prompt is purely informational (feature benefits + "manage your plan" copy). The future IAP PR passes a real `onUpgrade` that launches the purchase. The component contract does not change when IAP lands.
- Presented as a bottom-sheet/modal; dismissable.

### 4. Gate — road-quality overlay maxzoom (`screens/MapScreen.tsx`)

- `const { limit, isResolved } = useLimit("road_quality_max_zoom");`
- `const qualityMaxZoom = resolveQualityLayerMaxZoom(limit, isResolved, MOBILE_QUALITY_CEILING);`
- Set the quality `<Layer maxzoom={qualityMaxZoom}>` (the `<Layer>` supports `maxzoom`; today only the `<VectorSource>` caps at 22). The source keeps its over-zoom `maxzoom`; the LAYER carries the entitlement cap so MapLibre stops drawing quality past it.
- Hide the quality layer entirely if the cap yields a degenerate range (`qualityMaxZoom <= 0` — an operator override to 0). Mobile's overlay renders from z0, so unlike companion there is no minzoom-10 floor and no invalid-range risk for ordinary caps (a cap of 5 → layer `[0, 5)`, valid). Keep the existing `showQualityOverlay` toggle as-is; the cap composes with it.
- Optional discovery prompt (parity with companion's one-shot modal): when the map is zoomed past a FINITE cap with the overlay on, show `<UpgradePrompt>` once per session — only when `upgradeTierForLimit` has a target (no dead-end). MapLibre-native exposes zoom via `onRegionDidChange`/camera; feasibility to be confirmed in planning. If the prompt proves awkward on native, the clamp alone satisfies the enforcement requirement (this prompt is discovery UX, not a gate).

### 5. Gate — GPX export (`RideDetailScreen.tsx` + `SettingsScreen.tsx` bulk)

- `const { enabled: gpxEnabled, isResolved } = useFeature("gpx_export");`
- Proactive: when resolved-and-`!gpxEnabled`, the export action opens `<UpgradePrompt capability={{feature:"gpx_export"}}>` instead of exporting. While unresolved (pre-login edge), fail closed (disabled). On the bulk-export card, gate the GPX option only (CSV stays free).
- 403 safety net: since `/rides/*.gpx` is server-enforced, wrap `exportRideGpx`/`exportAllRidesGpx` calls so a `FEATURE_LIMIT_EXCEEDED`/`gpx_export` 403 (or the feature-guard 403) surfaces the upgrade prompt rather than a generic error — the backend is authoritative.

### 6. Gate — trip join 403 (`JoinTripScreen.tsx`) — ❌ REMOVED

- **Dropped post-review** (see the Correction above). `POST /trips/{id}/join` consumes a pre-reserved invite and cannot emit `FEATURE_LIMIT_EXCEEDED`, so there is no mobile join gate. `JoinTripScreen`'s `catch` uses generic error handling only; a bad/revoked code is a plain 403 "Invalid trip or invite code".

### 7. i18n

Add typed `EnglishMessageKey` catalog entries to `src/i18n/locales/en.ts` for: tier labels, "Upgrade required" / "Limit reached", the per-surface benefit/reason messages (GPX export is a Pro feature; the collaborator owner-cap message; the road-quality zoom reason), "Dismiss", and the informational upgrade copy. All prompt copy through `t()`.

## Testing

Mobile uses the existing test setup (Jest/RN Testing Library; see `screens/__tests__`, `components/__tests__`). Cover:

- `useEntitlements`/`useFeature`/`useLimit`: reads tier/feature/limit off a mocked auth store; fail-closed when no user.
- `resolveQualityLayerMaxZoom` (shared): free→12, unlimited→ceiling, unresolved→free/stricter-known, finite override preserved (extend the shared spec).
- `<UpgradePrompt>`: neutral vs upgrade title from `suppressUpgrade`/target; informational (no live purchase) CTA state.
- MapScreen: the quality `<Layer>` receives `maxzoom = resolved cap` (12 free / ceiling unlimited); hidden for a degenerate cap. (Assert props/config — MapLibre renders nothing in a headless test, mirroring the companion MapCanvas idiom.)
- GPX gate: `!gpx_export` opens the prompt (no export); enabled → exports; 403 → prompt.
- ~~Join: `FEATURE_LIMIT_EXCEEDED` → owner-cap banner message.~~ (gate removed — see Correction; `isFeatureLimitError` removed)

## Open items to resolve during planning

1. **Mobile unlimited ceiling** — confirm the road-tile source's real max zoom (companion uses 18; mobile's `<VectorSource maxzoom={22}>` may be loose). Use the true value as `MOBILE_QUALITY_CEILING`.
2. **Zoom-past discovery prompt on native** — confirm MapLibre-native camera/zoom event ergonomics; the prompt is optional (clamp is the enforcement), so drop it if the native event story is poor.
3. **`<UpgradePrompt>` presentation** — confirm the mobile UI-kit modal/bottom-sheet primitive to reuse.
4. **`gpx_export` 403 body shape** — confirm the feature-guard 403 (`Feature unavailable: gpx_export`) vs the limit 403 shape so the catch distinguishes "gate this to upgrade" from a real error.
