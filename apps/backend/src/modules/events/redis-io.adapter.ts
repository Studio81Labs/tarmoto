import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import type { Server, ServerOptions } from 'socket.io';

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
  private ioServer: Server | undefined;
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

    await Promise.all([pub.connect(), sub.connect()]);
    this.redisAdapter = createAdapter(pub, sub);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options) as Server;
    if (this.redisAdapter) {
      server.adapter(this.redisAdapter);
    }
    this.ioServer = server;
    return server;
  }
}
