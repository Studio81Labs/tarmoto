import { SetMetadata } from '@nestjs/common';
import type { FreeToggleFeatureKey } from '@tarmoto/shared';

export const REQUIRED_FEATURE_KILL_SWITCH_KEY = 'required_feature_kill_switch';

/**
 * Declare that a PUBLIC route is gated by a free-tier feature's operator
 * kill switch. Pair with `FeatureKillSwitchGuard`:
 *
 *   @UseGuards(FeatureKillSwitchGuard)
 *   @RequireFeatureKillSwitch('community_access')
 *
 * Unlike `@RequireFeature` / `FeatureGuard` this needs NO authenticated
 * user and resolves from the GLOBAL flag map only (fail-safe, default ON;
 * only an operator `force_off` blocks) via the shared
 * `resolveFeatureKillSwitch` — the same question the clients'
 * `useFeatureKillSwitch` / `serverKillSwitch` gates answer, so API and UI
 * cannot drift. That is exactly why it must NOT be swapped for
 * `@RequireFeature` on these routes: the per-user snapshot is unavailable
 * for anonymous callers and would fold in per-user overrides the kill
 * switch deliberately ignores. Typed to `FreeToggleFeatureKey` so it can
 * never be pointed at a PAID toggle (those gate fail-CLOSED per user).
 */
export const RequireFeatureKillSwitch = (key: FreeToggleFeatureKey) =>
  SetMetadata(REQUIRED_FEATURE_KILL_SWITCH_KEY, key);
