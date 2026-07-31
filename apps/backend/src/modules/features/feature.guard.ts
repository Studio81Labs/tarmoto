import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as express from 'express';
import type { ToggleFeatureKey } from '@tarmoto/shared';
import { FeatureResolver } from './feature-resolver.service.js';
import { REQUIRED_FEATURE_KEY } from './require-feature.decorator.js';

/**
 * Enforce a `@RequireFeature(...)` declaration. Resolution is live (tier +
 * per-user override + global override) so an operator kill switch blocks
 * the endpoint immediately, not on the next client refresh. Runs after
 * `AuthGuard` — it needs `request.user` to know whose entitlement to
 * check. Client UI gating is cosmetic; this guard is the authority.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: FeatureResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<
      ToggleFeatureKey | undefined
    >(REQUIRED_FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;

    const request = context.switchToHttp().getRequest<express.Request>();
    const userId = request.user?.userId;
    if (!userId) {
      // Wiring error: FeatureGuard placed before (or without) AuthGuard.
      throw new UnauthorizedException();
    }

    // Resolve the snapshot AND the `feature_states` read that produced it in a
    // SINGLE fetch — deriving `scope` from a second independent
    // `getGlobalStates()` could disagree if an operator clears a `force_off`
    // between the reads, mislabelling a global kill as a per-user denial.
    const { snapshot, globalStates } =
      await this.resolver.resolveForUserWithStates(userId);
    if (!snapshot[feature]) {
      // Include the machine-readable `feature` in the envelope (not just the
      // message) so a client can reliably tell WHICH kill switch fired — e.g.
      // the mobile offline hazard queue defers (retains) a `hazard_reporting`
      // rejection instead of dropping the report as a poison pill.
      //
      // Also expose the block's `scope` so the client can distinguish a
      // TEMPORARY operator shutdown from a PERSISTENT per-user denial. A
      // global `force_off` is an incident-driven pause that will lift, so a
      // queued report should be retained and retried (`scope: 'global'`).
      // A per-user override (an admin revoking one rider) or a tier denial
      // will never lift on its own, so the client must NOT silently retain
      // reports that can only age out — it surfaces the rejection instead
      // (`scope: 'user'`).
      const scope = globalStates[feature] === 'force_off' ? 'global' : 'user';
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: `Feature unavailable: ${feature}`,
        feature,
        scope,
      });
    }
    return true;
  }
}
