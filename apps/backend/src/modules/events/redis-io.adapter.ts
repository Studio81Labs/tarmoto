import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import type { createClient } from 'redis';

let adapterInstance: RedisIoAdapter | undefined;

/**
 * Custom IoAdapter that wires the Redis pub/sub adapter into the socket.io
 * server during creation. This avoids the NestJS v11 `afterInit` proxy issue
 * where `server.adapter()` is shadowed.
 *
 * Call `RedisIoAdapter.setAdapterClients(pub, sub)` from `afterInit` (where
 * Redis config is available), then the adapter is applied when the socket.io
 * server starts.
 */
export class RedisIoAdapter extends IoAdapter {
  private redisAdapter: ReturnType<typeof createAdapter> | undefined;

  constructor(app: INestApplicationContext) {
    super(app);
    adapterInstance = this;
  }

  /** Call from afterInit with connected Redis clients. */
  static setAdapterClients(
    pubClient: ReturnType<typeof createClient>,
    subClient: ReturnType<typeof createClient>,
  ): void {
    if (adapterInstance) {
      adapterInstance.redisAdapter = createAdapter(pubClient, subClient);
    }
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.redisAdapter) {
      server.adapter(this.redisAdapter);
    }
    return server;
  }
}
