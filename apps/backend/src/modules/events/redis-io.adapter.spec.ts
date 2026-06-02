import { EventEmitter } from 'node:events';
import type { INestApplicationContext } from '@nestjs/common';

// Fake node-redis client: an EventEmitter (so `.on('error')` / `.emit('error')`
// behave like the real client) with the handful of methods the adapter calls.
class FakeRedisClient extends EventEmitter {
  connect = jest.fn().mockResolvedValue(undefined);
  close = jest.fn().mockResolvedValue(undefined);
  duplicate = jest.fn();
}

const pubClient = new FakeRedisClient();
const subClient = new FakeRedisClient();
pubClient.duplicate.mockReturnValue(subClient);

jest.mock('redis', () => ({
  createClient: jest.fn(() => pubClient),
}));
jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: jest.fn(() => jest.fn()),
}));

// Imported after the mocks so the adapter binds to the mocked `redis`.
import { RedisIoAdapter } from './redis-io.adapter.js';

describe('RedisIoAdapter', () => {
  const config = { host: 'localhost', port: 6379 };

  function newAdapter(): RedisIoAdapter {
    // IoAdapter only stores the http server; connectRedis never touches it,
    // so a bare stub is enough for these tests.
    return new RedisIoAdapter({} as INestApplicationContext);
  }

  beforeEach(() => {
    pubClient.removeAllListeners();
    subClient.removeAllListeners();
    jest.clearAllMocks();
  });

  it('attaches error listeners so a socket error never crashes the process', async () => {
    const adapter = newAdapter();
    await adapter.connectRedis(config);

    // Both clients must carry an `error` listener — without one node-redis
    // re-throws the event and exits the process (the bug this guards).
    expect(pubClient.listenerCount('error')).toBeGreaterThan(0);
    expect(subClient.listenerCount('error')).toBeGreaterThan(0);

    // Emitting `error` on an EventEmitter with no listener throws; this
    // asserts the regression: a runtime ECONNRESET is swallowed, not fatal.
    expect(() =>
      pubClient.emit('error', new Error('read ECONNRESET')),
    ).not.toThrow();
    expect(() =>
      subClient.emit('error', new Error('read ECONNRESET')),
    ).not.toThrow();
  });

  it('keeps the error listener attached even when the initial connect fails', async () => {
    pubClient.connect.mockRejectedValueOnce(new Error('connect refused'));
    const adapter = newAdapter();

    // connectRedis rethrows so main.ts can fall back to in-memory pub/sub...
    await expect(adapter.connectRedis(config)).rejects.toThrow();

    // ...but the error listener was attached before connect, so node-redis's
    // reconnection attempts (which keep firing `error`) still can't crash us.
    expect(pubClient.listenerCount('error')).toBeGreaterThan(0);
    expect(() =>
      pubClient.emit('error', new Error('ECONNREFUSED')),
    ).not.toThrow();
  });
});
