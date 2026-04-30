/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Readable } from 'node:stream';
import { DataExportProcessor } from './data-export.processor.js';

describe('DataExportProcessor', () => {
  const baseUser = {
    id: 'u1',
    email: 'r@example.com',
    display_name: 'Rider',
  };
  const usersRepo = { findOne: jest.fn() };
  const service = {
    // Defaults to "row claimed successfully"; tests that exercise the
    // already-claimed bail-out path override this for that one call.
    markProcessing: jest.fn().mockResolvedValue(true),
    markReady: jest.fn(),
    markFailed: jest.fn(),
    findById: jest.fn().mockResolvedValue(null),
    buildPublicView: jest.fn(),
  };
  const storage = {
    write: jest.fn(),
    read: jest.fn(),
    delete: jest.fn(),
  };
  const assembler = {
    assemble: jest.fn(),
  };
  const email = {
    sendDataExportReady: jest.fn().mockResolvedValue(null),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service.markProcessing.mockResolvedValue(true);
    service.findById.mockResolvedValue(null);
    email.sendDataExportReady.mockResolvedValue(null);
  });

  function makeProcessor() {
    return new DataExportProcessor(
      usersRepo as never,
      service as never,
      storage as never,
      assembler as never,
      email as never,
    );
  }

  it('writes the archive to storage, marks ready, and emails the rider', async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockResolvedValue(Readable.from(Buffer.from('zip')));
    storage.write.mockResolvedValue({ byteSize: 3 });
    const expiresAt = new Date('2026-05-07T00:00:00Z');
    service.findById.mockResolvedValue({
      id: 'req-1',
      status: 'ready',
      expires_at: expiresAt,
    });
    service.buildPublicView.mockReturnValue({
      id: 'req-1',
      status: 'ready',
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date('2026-04-30T00:00:00Z').toISOString(),
      completedAt: new Date().toISOString(),
      downloadUrl:
        'https://api.tarmoto.app/api/v1/account/data-export/req-1/download?sig=x&exp=1',
      byteSize: 3,
      errorMessage: null,
    });

    const processor = makeProcessor();
    await processor.process('req-1', 'u1');

    expect(service.markProcessing).toHaveBeenCalledWith('req-1');
    expect(storage.write).toHaveBeenCalledWith(
      'u1/req-1.zip',
      expect.any(Readable),
    );
    expect(service.markReady).toHaveBeenCalledWith('req-1', 'u1/req-1.zip', 3);
    expect(service.markFailed).not.toHaveBeenCalled();
    // Wait one micro-tick for the fire-and-forget email promise to
    // settle so its assertion sees the awaited send call.
    await Promise.resolve();
    expect(email.sendDataExportReady).toHaveBeenCalledWith(
      'r@example.com',
      expect.objectContaining({
        displayName: 'Rider',
        downloadUrl: expect.stringContaining('req-1/download'),
        expiresAt,
      }),
    );
  });

  it('skips the email when the row is no longer ready (expired-during-write race)', async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockResolvedValue(Readable.from(Buffer.from('zip')));
    storage.write.mockResolvedValue({ byteSize: 3 });
    // Row was swept to 'expired' by the cleanup cron between
    // markReady and the post-write findById.
    service.findById.mockResolvedValue({ id: 'req-1', status: 'expired' });

    const processor = makeProcessor();
    await processor.process('req-1', 'u1');

    expect(service.markReady).toHaveBeenCalled();
    expect(email.sendDataExportReady).not.toHaveBeenCalled();
  });

  it('marks failed on assembler error', async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockRejectedValue(new Error('boom'));

    const processor = makeProcessor();
    await processor.process('req-1', 'u1');

    expect(service.markFailed).toHaveBeenCalledWith('req-1', 'boom');
    expect(service.markReady).not.toHaveBeenCalled();
  });

  it('marks failed on storage error', async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockResolvedValue(Readable.from(Buffer.from('zip')));
    storage.write.mockRejectedValue(new Error('disk full'));

    const processor = makeProcessor();
    await processor.process('req-1', 'u1');

    expect(service.markFailed).toHaveBeenCalledWith('req-1', 'disk full');
    expect(service.markReady).not.toHaveBeenCalled();
  });

  it('absorbs failures from markFailed itself instead of escaping', async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockRejectedValue(new Error('assembly boom'));
    service.markFailed.mockRejectedValue(new Error('db down'));

    const processor = makeProcessor();
    // Must resolve cleanly — a thrown markFailed in the catch block
    // would otherwise become an unhandled rejection in the
    // setImmediate dispatch and crash the worker.
    await expect(processor.process('req-1', 'u1')).resolves.toBeUndefined();
  });

  it('bails without touching storage when markProcessing returns false', async () => {
    // Stuck-row sweep moved this row off 'queued' before the worker
    // got to it — the conditional update affects 0 rows. The processor
    // must NOT continue, otherwise it would write a ZIP under a row
    // that no longer represents an active export.
    service.markProcessing.mockResolvedValueOnce(false);
    const processor = makeProcessor();
    await processor.process('req-1', 'u1');
    expect(usersRepo.findOne).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    expect(service.markReady).not.toHaveBeenCalled();
    expect(service.markFailed).not.toHaveBeenCalled();
  });

  it('marks failed when user is missing', async () => {
    usersRepo.findOne.mockResolvedValue(null);
    const processor = makeProcessor();
    await processor.process('req-1', 'u1');
    expect(service.markFailed).toHaveBeenCalledWith(
      'req-1',
      expect.stringContaining('user not found'),
    );
    expect(storage.write).not.toHaveBeenCalled();
  });
});
