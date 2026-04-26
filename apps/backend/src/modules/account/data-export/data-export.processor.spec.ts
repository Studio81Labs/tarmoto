import { Readable } from 'node:stream';
import { DataExportProcessor } from './data-export.processor.js';

describe('DataExportProcessor', () => {
  const baseUser = { id: 'u1', email: 'r@example.com' };
  const usersRepo = { findOne: jest.fn() };
  const service = {
    markProcessing: jest.fn(),
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
