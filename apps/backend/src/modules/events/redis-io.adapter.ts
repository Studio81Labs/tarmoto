import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import type { createClient } from 'redis';

let adapterInstance: RedisIoAdapter | undefined;

/**
 * Custom IoAdapter that wires the Redis pub/sub adapter into the socket.io
 * server. NestJS v11 proxies the `afterInit` server object and shadows
 * `server.adapter()`, so we apply the Redis adapter from within the IoAdapter.
 *
 * Lifecycle:
 * 1. `createIOServer` stores the raw socket.io server.
 * 2. `afterInit` connects Redis, calls `setAdapterClients`.
 * 3. `setAdapterClients` applies the Redis adapter to the stored server.
 */
export class RedisIoAdapter extends IoAdapter {
  private ioServer: Server | undefined;

  constructor(app: INestApplicationContext) {
    super(app);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    adapterInstance = this;
  }

  /** Call from afterInit with connected Redis clients. */
  static setAdapterClients(
    pubClient: ReturnType<typeof createClient>,
    subClient: ReturnType<typeof createClient>,
  ): void {
    if (adapterInstance?.ioServer) {
      adapterInstance.ioServer.adapter(createAdapter(pubClient, subClient));
    }
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options) as Server;
    this.ioServer = server;
    return server;
  }
}
