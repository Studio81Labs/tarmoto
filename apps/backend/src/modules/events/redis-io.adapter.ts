import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import type { ServerOptions } from 'socket.io';

/**
 * Render a node-redis socket error to a single log-friendly line. Plain
 * connection errors (`read ECONNRESET`) carry their detail in `.message`,
 * but Node's dual-stack `AggregateError` (IPv4 + IPv6 connect failures)
 * has an empty message and stashes its `code` on the top-level object —
 * so fall back to that to avoid logging a bare "Redis client error:".
 */
function describeRedisError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : err.name;
  }
  return String(err);
}

/**
 * Custom IoAdapter that wires the Redis pub/sub adapter into the socket.io
 * server during creation. NestJS v11 proxies the `afterInit` server object
 * and shadows `server.adapter()`, so we apply the Redis adapter before the
 * server starts.
 *
 * Call `connectRedis(config)` from main.ts before `app.listen()` to connect
 * to Redis and prepare the adapter.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient: ReturnType<typeof createClient> | undefined;
  private subClient: ReturnType<typeof createClient> | undefined;
  private redisAdapter: ReturnType<typeof createAdapter> | undefined;

  /**
   * Whether `connectRedis` attached the Redis pub/sub adapter in THIS
   * process. Static, not an instance getter: `main.ts` constructs the one
   * `RedisIoAdapter` directly and hands it to `app.useWebSocketAdapter()` —
   * a platform-level wiring point, not a Nest provider — so `EventsGateway`
   * has no DI path to the instance. There is only ever one instance per
   * process, so a static flag is exactly as accurate as an instance one.
   *
   * Read by `EventsGateway.onApplicationBootstrap` (#1104 review, PR #1287)
   * so its startup sweep can scope its own logging honestly. `connectRedis`
   * is a single best-effort attempt with a 5 s timeout and — on failure —
   * discards its clients with NO later retry, so a `false` reading is
   * permanent for this process's lifetime: a sweep must not claim a
   * cluster-wide result it cannot deliver, but it must also not skip
   * itself entirely, since a degraded instance's own directly-connected
   * sockets are invisible to every OTHER instance's cluster-wide sweep too
   * (the in-memory fallback isn't part of any Redis mesh) — skipping would
   * leave them unswept forever rather than merely incompletely swept.
   */
  static isClusterAdapterActive = false;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /** Connect to Redis and prepare the adapter. Call from main.ts. */
  async connectRedis(redisConfig: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  }): Promise<void> {
    const pub = createClient({
      socket: {
        host: redisConfig.host,
        port: redisConfig.port,
        connectTimeout: 5000,
      },
      ...(redisConfig.username ? { username: redisConfig.username } : {}),
      ...(redisConfig.password ? { password: redisConfig.password } : {}),
    });
    const sub = pub.duplicate();

    // node-redis REQUIRES an `error` listener on every client: without one,
    // a socket-level error (Docker port-forward resets the idle connection
    // as ECONNRESET; a downed Redis surfaces ECONNREFUSED on reconnect) is
    // re-emitted as an unhandled `error` event and takes down the whole
    // process. Log instead and let node-redis's built-in reconnection
    // recover — a transient Redis blip must never crash the backend. The
    // socket.io Redis adapter degrades to single-node fanout while a client
    // is mid-reconnect, which is acceptable; losing the entire API is not.
    pub.on('error', (err: unknown) => {
      this.logger.warn(`Redis pub client error: ${describeRedisError(err)}`);
    });
    sub.on('error', (err: unknown) => {
      this.logger.warn(`Redis sub client error: ${describeRedisError(err)}`);
    });

    // Race the connect against a 5 s timeout so bootstrap doesn't
    // hang when Redis is unreachable. If it fails, we throw and the
    // caller falls back to in-memory pub/sub. On success, both
    // clients keep their default reconnect logic for runtime recovery.
    const CONNECT_TIMEOUT_MS = 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([pub.connect(), sub.connect()]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Redis connect timed out')),
            CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
      this.pubClient = pub;
      this.subClient = sub;
      this.redisAdapter = createAdapter(pub, sub);
      RedisIoAdapter.isClusterAdapterActive = true;
    } catch (err) {
      // Clean up any partially connected client.
      await pub.close().catch(() => {});
      await sub.close().catch(() => {});
      throw err;
    } finally {
      // Always clear the timeout — on the failure path the rejection
      // settles the race, but the timer would otherwise leak and keep
      // the event loop alive for the full 5 s.
      clearTimeout(timer);
    }
  }

  /** Gracefully disconnect Redis clients. Call on application shutdown. */
  async closeRedisClients(): Promise<void> {
    if (this.pubClient) await this.pubClient.close().catch(() => {});
    if (this.subClient) await this.subClient.close().catch(() => {});
  }

  override createIOServer(port: number, options?: ServerOptions) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const server = super.createIOServer(port, options);
    if (this.redisAdapter) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      server.adapter(this.redisAdapter);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return server;
  }
}
