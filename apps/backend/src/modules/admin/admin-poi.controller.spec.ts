// `createReadStream`/`unlink` are stubbed so `uploadExtract`'s plumbing
// (multer temp file -> Readable -> storeExtract -> cleanup) is verifiable
// without touching the real filesystem — mirrors the `node:fs/promises`
// stub in `poi-import-admin.service.spec.ts`, but here the whole module is
// replaced (rather than spied per-export) since both `createReadStream`
// (`node:fs`) and `unlink` (`node:fs/promises`) come from different modules.
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...actual, createReadStream: jest.fn() };
});
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, unlink: jest.fn() };
});

import { BadRequestException } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { getAdminAuditTarget } from './admin-audit-context.js';
import type { AdminRequest } from './internal.guard.js';
import { AdminPoiController } from './admin-poi.controller.js';

const createReadStreamMock = jest.mocked(createReadStream);
const unlinkMock = jest.mocked(unlink);

describe('AdminPoiController', () => {
  // `.mockResolvedValue(...)` rather than `jest.fn(async () => ...)` — same
  // resolved-Promise behavior (mirrors each real `PoiImportAdminService`
  // method), but avoids `@typescript-eslint/require-await` tripping on an
  // async arrow with no `await` inside; matches the `.mockResolvedValue`
  // convention already used throughout `poi-import-admin.service.spec.ts`.
  const svc = {
    listRegionStatus: jest
      .fn()
      .mockResolvedValue([{ source: 'osm', code: 'CZ' }]),
    listRuns: jest.fn().mockResolvedValue([]),
    triggerImport: jest.fn().mockResolvedValue({ job_id: 'j' }),
    storeExtract: jest.fn().mockResolvedValue({
      present: true,
      size_bytes: 1,
      modified_at: 'x',
    }),
  };
  const ctrl = new AdminPoiController(svc as never);

  // Mirrors `admin-flags.controller.spec.ts`'s fake `AdminRequest` — a bare
  // object is enough since `setAdminAuditTarget`/`getAdminAuditTarget` just
  // stash/read a property on it, and neither mutating handler reads
  // `req.adminUser` directly (unlike `AdminFlagsController.setGlobal`).
  const adminReq = () => ({}) as unknown as AdminRequest;

  beforeEach(() => {
    createReadStreamMock.mockReset();
    unlinkMock.mockReset().mockResolvedValue(undefined);
  });

  it('GET regions delegates to the service', async () => {
    expect(await ctrl.regions()).toEqual([{ source: 'osm', code: 'CZ' }]);
  });

  it('POST import delegates with (source, code) and tags the audit target', async () => {
    const req = adminReq();

    expect(await ctrl.triggerImport(req, 'osm', 'CZ')).toEqual({
      job_id: 'j',
    });
    expect(svc.triggerImport).toHaveBeenCalledWith('osm', 'CZ');
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: 'poi_import',
      target_id: 'osm/CZ',
    });
  });

  it('GET runs passes the limit + filters', async () => {
    await ctrl.runs('osm', 'CZ', 20);
    expect(svc.listRuns).toHaveBeenCalledWith({
      source: 'osm',
      code: 'CZ',
      limit: 20,
    });
  });

  it('GET runs clamps an out-of-range limit to [1, 200] and omits absent filters', async () => {
    await ctrl.runs(undefined, undefined, 5000);
    expect(svc.listRuns).toHaveBeenCalledWith({ limit: 200 });

    await ctrl.runs(undefined, undefined, -3);
    expect(svc.listRuns).toHaveBeenCalledWith({ limit: 1 });
  });

  describe('uploadExtract', () => {
    const file = {
      path: '/tmp/multer-upload-xyz',
      size: 42,
      originalname: 'cz.osm',
    } as Express.Multer.File;

    it('rejects with 400 when no file is present, without calling the service', async () => {
      await expect(
        ctrl.uploadExtract(adminReq(), 'osm', 'CZ', undefined),
      ).rejects.toMatchObject({ status: 400 });

      expect(svc.storeExtract).not.toHaveBeenCalled();
      expect(unlinkMock).not.toHaveBeenCalled();
    });

    it("streams multer's temp file into storeExtract, tags the audit target, and cleans up on success", async () => {
      const fakeStream = { destroy: jest.fn() };
      createReadStreamMock.mockReturnValue(fakeStream as never);
      const req = adminReq();

      const result = await ctrl.uploadExtract(req, 'osm', 'CZ', file);

      expect(createReadStreamMock).toHaveBeenCalledWith(file.path);
      expect(svc.storeExtract).toHaveBeenCalledWith('osm', 'CZ', {
        stream: fakeStream,
        size: file.size,
        originalName: file.originalname,
      });
      expect(result).toEqual({
        present: true,
        size_bytes: 1,
        modified_at: 'x',
      });
      expect(getAdminAuditTarget(req)).toEqual({
        target_type: 'poi_import',
        target_id: 'osm/CZ',
      });
      // `storeExtract`'s own `pipeline()` already consumed + closed the
      // stream on this path — the handler must not ALSO destroy it.
      expect(fakeStream.destroy).not.toHaveBeenCalled();
      // Multer's OWN disk-temp file (distinct from storeExtract's internal
      // `.part` staging file, which it manages itself) is ours to remove.
      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });

    // #847 review Task 6 fix 1: `storeExtract` validates size/source/
    // code/extension BEFORE it ever starts reading from the stream, so a
    // rejected upload used to leave the just-opened read stream neither
    // consumed nor destroyed — an fd leak that only clears on process exit.
    // Repeated bad admin uploads (wrong extension, oversize, unknown
    // source/region) would eventually exhaust the process fd ulimit.
    it('destroys the stream, rethrows, and still cleans up the multer temp file when storeExtract rejects', async () => {
      const fakeStream = { destroy: jest.fn() };
      createReadStreamMock.mockReturnValue(fakeStream as never);
      const rejection = new BadRequestException('expected a .osm file');
      svc.storeExtract.mockRejectedValueOnce(rejection);

      await expect(
        ctrl.uploadExtract(adminReq(), 'osm', 'CZ', file),
      ).rejects.toBe(rejection);

      expect(fakeStream.destroy).toHaveBeenCalledTimes(1);
      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });
  });
});
