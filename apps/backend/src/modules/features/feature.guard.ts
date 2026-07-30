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

    const snapshot = await this.resolver.resolveForUser(userId);
    if (!snapshot[feature]) {
      // Include the machine-readable `feature` in the envelope (not just the
      // message) so a client can reliably tell WHICH kill switch fired — e.g.
      // the mobile offline hazard queue defers (retains) a `hazard_reporting`
      // rejection instead of dropping the report as a poison pill.
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: `Feature unavailable: ${feature}`,
        feature,
      });
    }
    return true;
  }
}
