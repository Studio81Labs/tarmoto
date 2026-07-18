import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SystemFeatureKey } from '@tarmoto/shared';
import { FeatureResolver } from './feature-resolver.service.js';
import { REQUIRED_SYSTEM_SWITCH_KEY } from './require-system-switch.decorator.js';

/**
 * Enforce a `@RequireSystemSwitch(...)` declaration. When an operator has
 * turned the switch off, reject with 503 in the guard phase — before
 * interceptors (e.g. `FilesInterceptor`) parse and buffer the request body
 * — so a killed feature does no expensive per-request work first and the
 * kill switch sheds the exact upload/spam load it exists to stop. Resolution
 * is uncached (`isSystemSwitchEnabled`) so the kill takes effect immediately,
 * not on the next client refresh.
 *
 * No auth dependency: a system switch is global, not per-user, so this may
 * run before `AuthGuard`. Routes still keep their service-level gate as the
 * authoritative write guarantee; this guard is the early rejection.
 */
@Injectable()
export class SystemSwitchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: FeatureResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<SystemFeatureKey | undefined>(
      REQUIRED_SYSTEM_SWITCH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!key) return true;

    if (!(await this.resolver.isSystemSwitchEnabled(key))) {
      throw new ServiceUnavailableException(
        'This feature is temporarily unavailable',
      );
    }
    return true;
  }
}
