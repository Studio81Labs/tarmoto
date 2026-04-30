import { Readable } from 'node:stream';
import { DataExportProcessor } from './data-export.processor.js';

describe('DataExportProcessor', () => {
  const baseUser = { id: 'u1', email: 'r@example.com' };
  const usersRepo = { findOne: jest.fn() };
  const service = {
    // Defaults to "row claimed successfully"; tests that exercise the
    // already-claimed bail-out path override this for that one call.
    markProcessing: jest.fn().mockResolvedValue(true),
    markReady: jest.fn(),
    markFailed: jest.fn(),
  };
  const storage = {
    write: jest.fn(),
    read: jest.fn(),
    delete: jest.fn(),
  };
  const assembler = {
    assemble: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service.markProcessing.mockResolvedValue(true);
  });

  function makeProcessor() {
    return new DataExportProcessor(
      usersRepo as never,
      service as never,
      storage as never,
      assembler as never,
    );
  }

  it('writes the archive to storage and marks ready', async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockResolvedValue(Readable.from(Buffer.from('zip')));
    storage.write.mockResolvedValue({ byteSize: 3 });

    const processor = makeProcessor();
    await processor.process('req-1', 'u1');

    expect(service.markProcessing).toHaveBeenCalledWith('req-1');
    expect(storage.write).toHaveBeenCalledWith(
      'u1/req-1.zip',
      expect.any(Readable),
    );
    expect(service.markReady).toHaveBeenCalledWith('req-1', 'u1/req-1.zip', 3);
    expect(service.markFailed).not.toHaveBeenCalled();
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
