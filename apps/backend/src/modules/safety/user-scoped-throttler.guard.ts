import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Crash-alert specific throttler that buckets by `(ip, user_id)`
 * instead of just IP.
 *
 * Without this, riders behind shared NAT or carrier-grade proxies
 * would compete for the same 5/min budget — one noisy client could
 * cause every other authenticated user on that IP to get a 429 on
 * their first crash alert. For a safety endpoint that's
 * unacceptable; the per-user component lets each authenticated rider
 * exhaust their own budget without affecting peers on the same
 * upstream IP.
 *
 * IP is preserved in the key so an unauthenticated burst (caught
 * before AuthGuard runs in a misconfigured deploy) still gets
 * limited.
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
