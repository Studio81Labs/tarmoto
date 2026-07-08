import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { SHARED_THROTTLE_BUCKET } from './shared-throttle-bucket.decorator.js';

/**
 * App-wide throttler that buckets by `(ip, user_id)` instead of just
 * IP. Wired as the global `APP_GUARD` in `app.module.ts`.
 *
 * Without this, riders behind shared NAT or carrier-grade proxies
 * would compete for the same per-route budget — one noisy client
 * could cause every other authenticated user on that IP to get a 429,
 * which is especially bad on the safety / crash-alert endpoint where
 * 429 means an emergency notification doesn't go out. The per-user
 * component lets each authenticated rider exhaust their own budget
 * without affecting peers on the same upstream IP.
 *
 * Order matters: this guard runs as a global APP_GUARD, BEFORE any
 * controller-level `AuthGuard`. We can't rely on `req.user` already
 * being populated, so `getTracker` verifies the JWT inline (sharing
 * the globally-registered `JwtService`) to derive the same `userId`
 * AuthGuard will see. If the token is missing or invalid we fall
 * back to `${ip}:anon` — the request will subsequently 401 from
 * AuthGuard, but we've already credited the abuse to that IP's anon
 * bucket so the throttle still applies.
 *
 * For genuinely unauthenticated routes (`/auth/login`, `/auth/refresh`)
 * the keying degrades to `${ip}:anon`, which is functionally
 * equivalent to IP-only on those routes.
 *
 * Per-route limits are still configured via `@Throttle({ default: { ttl, limit } })`;
 * this guard only changes the keying, not the budget shape.
 *
 * Routes may additionally opt into a shared bucket via `@SharedThrottleBucket()`
 * so a controller's whole `@Throttle` budget applies per user ACROSS its
 * handlers (see `generateKey`) — needed by upstream-facing proxies like
 * geocoding. Everything else keeps the default per-handler keying.
 */
@Injectable()
export class UserScopedThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject('THROTTLER:MODULE_OPTIONS') options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const ip = typeof req['ip'] === 'string' ? req['ip'] : 'unknown-ip';
    const userId = await this.resolveUserId(req);
    return `${ip}:${userId}`;
  }

  /**
   * Default keying is per (class, HANDLER, tracker) — a class-level `@Throttle`
   * therefore gives each action its own bucket. Routes flagged with
   * {@link SharedThrottleBucket} drop the handler from the key so all the
   * controller's handlers share ONE per-user bucket (the controller's budget,
   * not per-action). Unflagged routes fall through to the default `super`
   * keying unchanged — this guard fronts safety-critical routes, so the shared
   * bucket is strictly opt-in.
   */
  protected override generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    const shared = this.reflector.getAllAndOverride<boolean>(
      SHARED_THROTTLE_BUCKET,
      [context.getHandler(), context.getClass()],
    );
    if (shared) {
      return `${context.getClass().name}:shared:${name}:${suffix}`;
    }
    return super.generateKey(context, suffix, name);
  }

  /**
   * Try in order:
   *   1. `req.user.userId` set by an upstream guard / middleware
   *      (works for routes where AuthGuard already ran via, say, a
   *      module-level UseGuards).
   *   2. JWT verification of the `Authorization: Bearer …` header.
   *   3. `'anon'` fallback.
   *
   * Verification (not just decode) is intentional: an attacker could
   * otherwise rotate fake `sub` values in unsigned tokens to dodge
   * the per-user bucket and burst us. A failed verify costs one
   * extra crypto op per request — acceptable for a guard that runs
   * in front of every authenticated route.
   */
  private async resolveUserId(req: Record<string, unknown>): Promise<string> {
    const fromContext = (req as { user?: { userId?: string } }).user?.userId;
    if (typeof fromContext === 'string' && fromContext.length > 0) {
      return fromContext;
    }
    const headers = req['headers'] as Record<string, string | undefined>;
    const auth = headers?.['authorization'];
    if (!auth) return 'anon';
    const [scheme, token] = auth.split(' ');
    if (scheme !== 'Bearer' || !token) return 'anon';
    try {
      const payload = await this.jwt.verifyAsync<{
        sub?: string;
        type?: string;
      }>(token);
      if (payload.type !== 'access') return 'anon';
      return typeof payload.sub === 'string' && payload.sub.length > 0
        ? payload.sub
        : 'anon';
    } catch {
      // Invalid / expired token. AuthGuard will 401 the request; we
      // just bucket this attempt to the IP's anon quota.
      return 'anon';
    }
  }
}
