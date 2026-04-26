import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

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
 * For unauthenticated routes (`/auth/login`, `/auth/refresh`, etc.)
 * the user component falls back to a literal `"anon"`, which makes
 * the keying functionally equivalent to IP-only on those routes —
 * preserving the abuse protection we already had.
 *
 * Per-route limits are still configured via `@Throttle({ default: { ttl, limit } })`;
 * this guard only changes the keying, not the budget shape.
 */
@Injectable()
export class UserScopedThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = typeof req['ip'] === 'string' ? req['ip'] : 'unknown-ip';
    const user = req['user'] as { userId?: string } | undefined;
    const userId = typeof user?.userId === 'string' ? user.userId : 'anon';
    return Promise.resolve(`${ip}:${userId}`);
  }
}
