import { ConflictException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { PoiUploadLockInterceptor } from './poi-upload-lock.interceptor.js';
import {
  UPLOAD_LOCK_RENEW_INTERVAL_MS,
  type PoiImportAdminService,
} from '../poi/poi-import-admin.service.js';

function contextFor(source: string, code: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params: { source, code } }) }),
  } as unknown as ExecutionContext;
}

function makeSvc(): {
  interceptor: PoiUploadLockInterceptor;
  acquire: jest.Mock;
  renew: jest.Mock;
  release: jest.Mock;
} {
  const acquire = jest.fn();
  const renew = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);
  const svc = {
    acquireUploadLock: acquire,
    renewUploadLock: renew,
    releaseUploadLock: release,
  } as unknown as PoiImportAdminService;
  return {
    interceptor: new PoiUploadLockInterceptor(svc),
    acquire,
    renew,
    release,
  };
}

describe('PoiUploadLockInterceptor', () => {
  it('acquires the lock, runs the handler, then releases its own token on success', async () => {
    const { interceptor, acquire, release } = makeSvc();
    acquire.mockResolvedValue('tok-1');
    const next: CallHandler = { handle: () => of('stat') };

    const result = await firstValueFrom(
      await interceptor.intercept(contextFor('osm', 'CZ'), next),
    );

    expect(result).toBe('stat');
    expect(acquire).toHaveBeenCalledWith('osm', 'CZ');
    expect(release).toHaveBeenCalledWith('osm', 'CZ', 'tok-1');
  });

  it('rejects a concurrent upload with 409 before the handler runs — no drain, no release', async () => {
    const { interceptor, acquire, release } = makeSvc();
    acquire.mockResolvedValue(null); // NX failed → lock already held
    const handle = jest.fn();

    await expect(
      interceptor.intercept(contextFor('osm', 'CZ'), {
        handle,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // FileInterceptor (next) never runs → the loser's body is never drained,
    // and there's nothing to release since we never acquired.
    expect(handle).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases the lock even when the handler errors mid-write', async () => {
    const { interceptor, acquire, release } = makeSvc();
    acquire.mockResolvedValue('tok-2');
    const next: CallHandler = {
      handle: () => throwError(() => new Error('write failed')),
    };

    await expect(
      firstValueFrom(
        await interceptor.intercept(contextFor('osm', 'CZ'), next),
      ),
    ).rejects.toThrow('write failed');

    expect(release).toHaveBeenCalledWith('osm', 'CZ', 'tok-2');
  });

  it('renews the lock on an interval while in flight, and stops once it settles (#972 review)', async () => {
    jest.useFakeTimers();
    try {
      const { interceptor, acquire, renew, release } = makeSvc();
      acquire.mockResolvedValue('tok-3');
      // A handler we hold open to simulate a long, still-streaming upload.
      const handler = new Subject<unknown>();
      const next: CallHandler = { handle: () => handler.asObservable() };

      const obs = await interceptor.intercept(contextFor('osm', 'CZ'), next);
      const sub = obs.subscribe({ error: () => undefined });

      // Two renewal intervals elapse mid-upload → two token-checked renews,
      // so the lock never lapses even though the upload outlives the TTL.
      jest.advanceTimersByTime(UPLOAD_LOCK_RENEW_INTERVAL_MS * 2);
      expect(renew).toHaveBeenCalledTimes(2);
      expect(renew).toHaveBeenLastCalledWith('osm', 'CZ', 'tok-3');

      // Upload finishes → heartbeat cleared, lock released, no further renews.
      handler.complete();
      jest.advanceTimersByTime(UPLOAD_LOCK_RENEW_INTERVAL_MS * 3);
      expect(renew).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledWith('osm', 'CZ', 'tok-3');

      sub.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });
});
