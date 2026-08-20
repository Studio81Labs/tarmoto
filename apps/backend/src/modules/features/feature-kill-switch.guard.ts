import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  resolveFeatureKillSwitch,
  type FreeToggleFeatureKey,
} from '@tarmoto/shared';
import { FeatureResolver } from './feature-resolver.service.js';
import { REQUIRED_FEATURE_KILL_SWITCH_KEY } from './require-feature-kill-switch.decorator.js';

/**
 * Enforce a `@RequireFeatureKillSwitch(...)` declaration on a public
 * (unauthenticated or optionally-authenticated) route.
 *
 * Resolution reads the global `feature_states` map and folds it through the
 * shared `resolveFeatureKillSwitch` — deliberately NOT the per-user snapshot
 * (`FeatureGuard`): these routes have no (or optional) auth, and the API must
 * answer the same question as the clients' `useFeatureKillSwitch` /
 * `serverKillSwitch` gates so they cannot drift (the `road_quality_overlay`
 * CSV-export precedent, #1206). Uncached, so an operator `force_off` takes
 * effect on the next request.
 *
 * Rejection is the `FeatureForbiddenDto` envelope `FeatureGuard` throws, with
 * `scope: 'global'` unconditionally: a free-tier kill switch resolves off
 * ONLY on a global `force_off`, and `'global'` tells clients this is a
 * TEMPORARY operator shutdown — keep the link, retry later.
 *
 * No auth dependency: the switch is global, so the guard never reads
 * `request.user` and may run before (or without) any auth guard.
 */
@Injectable()
export class FeatureKillSwitchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: FeatureResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<
      FreeToggleFeatureKey | undefined
    >(REQUIRED_FEATURE_KILL_SWITCH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!key) return true;

    const globalStates = await this.resolver.getGlobalStates();
    if (!resolveFeatureKillSwitch(key, globalStates[key])) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: `Feature unavailable: ${key}`,
        feature: key,
        scope: 'global',
      });
    }
    return true;
  }
}
