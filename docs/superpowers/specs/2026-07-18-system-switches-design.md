# System Switches (Feature-Flag Catalog Phase 2) — Design

- **Date:** 2026-07-18
- **Status:** Approved (design); pending implementation plan
- **Builds on:** the kind-split entitlement registry (`packages/shared/src/feature-flags.ts`, `toggle | limit`) shipped in #1032/#1034, the global-override table `feature_states`, `FeatureResolver`, and the `admin-flags` / `admin-limits` twin admin surfaces. Catalog: `docs/feature-flags.md` §3; the intended architecture is recorded in that doc's §6.1.
- **Scope:** the **system-switch mechanism** — a third registry kind for operator-only, default-on, no-tier global kill toggles — plus its admin surface and the 14 `sys_*` switches from catalog §3. **Mechanism + admin only**; no per-switch enforcement wiring (that is a per-subsystem follow-up, exactly as entitlement enforcement is).

## 1. Background & motivation

Catalog §3 defines **system switches**: global operational kill toggles for subsystems and third-party dependencies (`sys_accel_collection`, `sys_weather_provider`, `sys_ride_publishing`, …). They are **not entitlements** — no tier, no per-user layer, and they default **on** (`true`); an operator flips one **off** during an incident (provider outage, bad model, moderation event) and the subsystem degrades gracefully.

The entitlement registry can't express them today: it has only `toggle` (default false, tier-granted) and `limit` kinds. This phase adds the mechanism.

## 2. Decisions (user-confirmed)

1. **Mechanism + admin only** — registry, resolution, admin surface/UI, wire, tests. No `sys_*` switch is wired to its subsystem in this phase; enforcement is a per-feature follow-up (same define-first pattern flags/limits shipped with). A switch does nothing until wired.
2. **Reuse `feature_states`** for the operator override (no new table), served on the existing `GET /config/flags`.
3. **No migration / no seed** — default-on means zero rows until an operator disables a switch.
4. **Dedicated admin surface** (`/admin/system-switches`), grouped separately from entitlement flags in the console.

## 3. Design

### 3.1 Registry (`packages/shared/src/feature-flags.ts`)

Add a third member to the `FeatureDefinition` union:

```ts
export interface SystemFeatureDefinition {
  kind: "system";
  description: string;
  /** System switches default ON; an operator force_off is the only way off. */
  default: true;
}
export type FeatureDefinition =
  ToggleFeatureDefinition | LimitFeatureDefinition | SystemFeatureDefinition;
```

Add the 14 `sys_*` entries (catalog §3) to `FEATURE_DEFINITIONS`, all `{ kind: "system", default: true }`. Derived types/consts, mirroring the toggle/limit split:

- `SystemFeatureKey` (conditional type over the definitions), `SYSTEM_FEATURE_KEYS`.
- `isSystemFeatureKey(v): v is SystemFeatureKey`.
- `SystemSwitchSnapshot = Record<SystemFeatureKey, boolean>`.

`FeatureKey` grows to the full union; `TOGGLE_FEATURE_KEYS` / `LIMIT_FEATURE_KEYS` stay exactly as-is, so entitlement resolution, `FeatureSnapshotDto`/`LimitSnapshotDto`, and the flag/limit admin listings (which iterate those arrays) are **untouched** — system keys never leak into the per-user snapshot or the entitlement admin surfaces.

Registry-invariant test update: the existing "partitions FEATURE_KEYS into toggle + limit" becomes a 3-way partition (`toggle + limit + system == all`, each key's kind matches its bucket).

### 3.2 Resolution

System switches can't reuse `resolveFeature` (toggle-typed, reads `def.tiers`). A dedicated pure resolver:

```ts
/** On unless an operator has forced it off. `force_on` is meaningless
 * (default is already on) and treated as on. */
export function resolveSystemSwitch(
  key: SystemFeatureKey,
  globalState: GlobalFeatureState | undefined,
): boolean {
  return globalState !== "force_off";
}

export function buildSystemSwitchSnapshot(
  globalStates: Readonly<Partial<Record<string, GlobalFeatureState>>>,
): SystemSwitchSnapshot {
  const snapshot = {} as SystemSwitchSnapshot;
  for (const key of SYSTEM_FEATURE_KEYS) {
    snapshot[key] = resolveSystemSwitch(key, globalStates[key]);
  }
  return snapshot;
}
```

`null`/absent state ⇒ on (default). Unknown keys in the map are ignored (only registry keys are iterated).

### 3.3 Wire — no new endpoint

`FeatureResolver.getGlobalStates()` already returns **all** `feature_states` rows (no registry filter), so a `sys_*` `force_off` already rides on the existing **`GET /api/v1/config/flags`** override map. Clients resolve a switch with the shared `buildSystemSwitchSnapshot(configFlags)` — the shared registry supplies the default-on, so "absent = on" is handled centrally and there is no fail-closed conflict (a missing key correctly resolves on, not off). No new endpoint, field, or DTO on the client wire.

Backend addition for the resolver's own consumers (and future enforcement): `FeatureResolver.getSystemSwitches(): Promise<SystemSwitchSnapshot>` = `buildSystemSwitchSnapshot(await getGlobalStates())`. Not called by any guard in this phase.

### 3.4 Admin surface (`apps/backend/src/modules/admin-system-switches/`)

A twin of `admin-flags`/`admin-limits`, but simpler — global-only, and the only operator actions are **disable** / **enable**:

- `GET /admin/system-switches` (support+) → `AdminSystemSwitchesResponseDto { switches: AdminSystemSwitchDto[] }`. Each row: `key`, `description`, `enabled: boolean` (resolved), `disabled_reason: string | null`, `disabled_by: string | null`, `disabled_at: string | null`.
- `PUT /admin/system-switches/:key/disable` (admin+) body `SetSystemSwitchDisabledDto { reason: string }` (reason **required** — a kill switch must carry incident context) → writes/updates the `feature_states` row `state = 'force_off', reason, updated_by`. Returns the refreshed `AdminSystemSwitchDto`.
- `DELETE /admin/system-switches/:key/disable` (admin+, 204) → clears the row (re-enable). Idempotent.

`assertKnownSystemSwitch` uses `isSystemFeatureKey` (toggle/limit keys ⇒ 400). Reuses the `FeatureState` repository. **No per-user endpoints, no user listing** (system switches are global-only). Audit `target_type: 'system_switch'`, `target_id: key`, via the standard interceptor. The `feature_states` state CHECK already allows `force_off`; no schema change.

Reuse note: entitlement globals (`PUT /admin/feature-flags/:feature/global`, which allows `force_on`) reject `sys_*` keys via their own `isToggleFeatureKey` guard, and this surface rejects non-system keys — clean separation over the shared table (rows never collide; `feature` is unique).

### 3.5 Admin UI

A **System switches** section (`SystemSwitchesCard`) on the existing `FeatureFlagsScreen`, mirroring exactly how the Limits card was added in #1034 — a `DataTable` below the flags/limits sections. Flat list of the 14 switches, each showing resolved on/off (a Pill), the disable reason when off, and an **Enable/Disable** action; disabling opens a mandatory-reason dialog (mirrors the force-off dialog on the flags screen). Data hooks via `$api` (`useAdminSystemSwitches`, `useDisableSystemSwitch`, `useEnableSystemSwitch`) in the existing `useAdminFlags.ts`. No category grouping in v1 (14 flat items; the catalog's §3.1–3.4 grouping stays documentation-only — YAGNI).

### 3.6 Testing

- **Shared**: 3-way kind partition; `resolveSystemSwitch` (on default, off on force_off, on on force_on/absent); `buildSystemSwitchSnapshot` (every key, stale-key immunity); `isSystemFeatureKey`; a check that `SYSTEM_FEATURE_KEYS` is disjoint from toggle/limit keys.
- **Backend**: `FeatureResolver.getSystemSwitches`; admin-system-switches service/controller/dto (disable/enable/idempotent-clear, reason required, unknown + wrong-kind key ⇒ 400, roles, audit target).
- **Admin UI**: list renders resolved state; disable fires the mutation with reason; enable fires the clear; mandatory-reason validation.
- **Contract**: OpenAPI + generated client regenerated (new admin endpoints); all consumers typecheck.

## 4. Out of scope (follow-ups)

- **Per-switch enforcement** — wiring each `sys_*` to its subsystem (backend guards for `sys_weather_provider`/`sys_nap_*`/`sys_mapillary_previews`/`sys_ride_publishing`/`sys_poi_ratings`; mobile checks for `sys_accel_collection`/`sys_surface_upload`/`sys_surface_ml_classification`/`carplay`). Each is its own change; the mechanism + `getSystemSwitches()` resolver make them small.
- **Client consumption** of the resolved switch map (mobile/companion reading `/config/flags` through `buildSystemSwitchSnapshot`).
- **Category grouping** in the admin UI, if 14 flat items ever becomes unwieldy.
