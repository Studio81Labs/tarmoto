import { ConflictException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { PoiUploadLockInterceptor } from './poi-upload-lock.interceptor.js';
import type { PoiImportAdminService } from '../poi/poi-import-admin.service.js';

function contextFor(source: string, code: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params: { source, code } }) }),
  } as unknown as ExecutionContext;
}

function makeSvc(): {
  interceptor: PoiUploadLockInterceptor;
  acquire: jest.Mock;
  release: jest.Mock;
} {
  const acquire = jest.fn();
  const release = jest.fn().mockResolvedValue(undefined);
  const svc = {
    acquireUploadLock: acquire,
    releaseUploadLock: release,
  } as unknown as PoiImportAdminService;
  return { interceptor: new PoiUploadLockInterceptor(svc), acquire, release };
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
});
