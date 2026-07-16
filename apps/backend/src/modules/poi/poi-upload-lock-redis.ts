import { Redis } from 'ioredis';
import type { ConfigService } from '@nestjs/config';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

/**
 * DI token for the dedicated ioredis client backing the POI upload lock
 * (#972). Phase 3 removed the `poi.import` queue from the backend, so the lock
 * can no longer borrow `this.queue.client` — this small client replaces it,
 * built from the same TARMOTO_REDIS_* config the BullMQ connection used.
 */
export const POI_UPLOAD_LOCK_REDIS = Symbol('POI_UPLOAD_LOCK_REDIS');

export function createPoiUploadLockRedis(config: ConfigService): Redis {
  return new Redis({
    host: config.get<string>('TARMOTO_REDIS_HOST') ?? 'localhost',
    port: Number.parseInt(
      config.get<string>('TARMOTO_REDIS_PORT') ?? '6379',
      10,
    ),
    username: config.get<string>('TARMOTO_REDIS_USERNAME') || undefined,
    password: config.get<string>('TARMOTO_REDIS_PASSWORD') || undefined,
    // The lock methods issue one-shot commands; no blocking reads.
    maxRetriesPerRequest: null,
    // Don't hammer Redis at boot if it's briefly down — the lock is a
    // best-effort guard with a TTL backstop.
    lazyConnect: false,
  });
}

/**
 * Closes the dedicated lock-redis connection on Nest shutdown. Unlike the old
 * `this.queue.client` borrow, BullMQ doesn't manage this connection's
 * lifecycle — nothing else ever closes it, so a live client left open past
 * `app.close()` keeps its socket (and reconnect timers) alive, which in turn
 * keeps the process's event loop from ever draining. That silently hangs any
 * script that boots the full `AppModule` and expects to exit after
 * `app.close()` — including `pnpm openapi:export`, which readonly-inspects
 * Nest's decorator metadata and only ever intended a clean, short-lived
 * process. Mirrors `PushModule`'s `PushProviderShutdownHook` for the APN
 * HTTP/2 pool — the established pattern in this codebase for tearing down an
 * externally-constructed client a DI token merely hands out.
 */
@Injectable()
export class PoiUploadLockRedisShutdownHook implements OnApplicationShutdown {
  constructor(@Inject(POI_UPLOAD_LOCK_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
