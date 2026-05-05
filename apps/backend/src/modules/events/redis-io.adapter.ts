import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import type { ServerOptions } from 'socket.io';

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
  private pubClient: ReturnType<typeof createClient> | undefined;
  private subClient: ReturnType<typeof createClient> | undefined;
  private redisAdapter: ReturnType<typeof createAdapter> | undefined;

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
      socket: { host: redisConfig.host, port: redisConfig.port },
      ...(redisConfig.username ? { username: redisConfig.username } : {}),
      ...(redisConfig.password ? { password: redisConfig.password } : {}),
    });
    const sub = pub.duplicate();

    try {
      await Promise.all([pub.connect(), sub.connect()]);
      this.pubClient = pub;
      this.subClient = sub;
      this.redisAdapter = createAdapter(pub, sub);
    } catch (err) {
      // Clean up any partially connected client.
      await pub.close().catch(() => {});
      await sub.close().catch(() => {});
      throw err;
    }
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
