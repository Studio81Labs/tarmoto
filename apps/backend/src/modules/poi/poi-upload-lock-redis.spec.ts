import { PoiUploadLockRedisShutdownHook } from './poi-upload-lock-redis.js';

describe('PoiUploadLockRedisShutdownHook', () => {
  it('closes the lock-redis connection on application shutdown', async () => {
    const redis = { quit: jest.fn().mockResolvedValue('OK') };
    const hook = new PoiUploadLockRedisShutdownHook(redis as never);

    await hook.onApplicationShutdown();

    expect(redis.quit).toHaveBeenCalledTimes(1);
  });
});
