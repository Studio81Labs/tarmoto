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

import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
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

  beforeEach(() => {
    createReadStreamMock.mockReset();
    unlinkMock.mockReset().mockResolvedValue(undefined);
  });

  it('GET regions delegates to the service', async () => {
    expect(await ctrl.regions()).toEqual([{ source: 'osm', code: 'CZ' }]);
  });

  it('POST import delegates with (source, code)', async () => {
    expect(await ctrl.triggerImport('osm', 'CZ')).toEqual({ job_id: 'j' });
    expect(svc.triggerImport).toHaveBeenCalledWith('osm', 'CZ');
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
        ctrl.uploadExtract('osm', 'CZ', undefined),
      ).rejects.toMatchObject({ status: 400 });

      expect(svc.storeExtract).not.toHaveBeenCalled();
      expect(unlinkMock).not.toHaveBeenCalled();
    });

    it("streams multer's temp file into storeExtract and cleans it up on success", async () => {
      const fakeStream = {} as never;
      createReadStreamMock.mockReturnValue(fakeStream);

      const result = await ctrl.uploadExtract('osm', 'CZ', file);

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
      // Multer's OWN disk-temp file (distinct from storeExtract's internal
      // `.part` staging file, which it manages itself) is ours to remove.
      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });

    it('still cleans up the multer temp file when storeExtract rejects', async () => {
      createReadStreamMock.mockReturnValue({} as never);
      svc.storeExtract.mockRejectedValueOnce(new Error('boom'));

      await expect(ctrl.uploadExtract('osm', 'CZ', file)).rejects.toThrow(
        'boom',
      );

      expect(unlinkMock).toHaveBeenCalledWith(file.path);
    });
  });
});
