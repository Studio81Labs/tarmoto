import { Redis } from 'ioredis';
import type { ConfigService } from '@nestjs/config';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

/**
 * DI token for the dedicated ioredis client backing the per-rider
 * subscription-mutation lock ({@link SubscriptionMutationLockService}). A
 * DEDICATED client (not the BullMQ connection) so a slow/backed-up queue can
 * never starve the billing critical section, mirroring
 * {@link POI_UPLOAD_LOCK_REDIS}. Built from the same `TARMOTO_REDIS_*` config.
 */
export const SUBSCRIPTION_LOCK_REDIS = Symbol('SUBSCRIPTION_LOCK_REDIS');

export function createSubscriptionLockRedis(config: ConfigService): Redis {
  return new Redis({
    host: config.get<string>('TARMOTO_REDIS_HOST') ?? 'localhost',
    port: Number.parseInt(
      config.get<string>('TARMOTO_REDIS_PORT') ?? '6379',
      10,
    ),
    username: config.get<string>('TARMOTO_REDIS_USERNAME') || undefined,
    password: config.get<string>('TARMOTO_REDIS_PASSWORD') || undefined,
    // The lock issues only one-shot commands (SET NX / EVAL); no blocking reads.
    maxRetriesPerRequest: null,
    // Eager connect (ioredis default) — the shutdown hook below closes it so the
    // socket + reconnect timers can't keep the event loop alive past
    // `app.close()` (would hang `openapi:gen`), matching the POI lock client.
    lazyConnect: false,
  });
}

/**
 * Closes the dedicated subscription-lock Redis connection on Nest shutdown.
 * BullMQ does not manage this connection's lifecycle, so without this its
 * eagerly-opened socket + reconnect timers would keep the process event loop
 * from draining after `app.close()` — hanging any short-lived script that boots
 * `AppModule` (e.g. `pnpm openapi:export`). Mirrors
 * {@link PoiUploadLockRedisShutdownHook}.
 */
@Injectable()
export class SubscriptionLockRedisShutdownHook implements OnApplicationShutdown {
  constructor(@Inject(SUBSCRIPTION_LOCK_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
