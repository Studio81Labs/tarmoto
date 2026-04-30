import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PassThrough, Readable } from 'node:stream';
import { DataExportController } from './data-export.controller.js';
import { DataExportService } from './data-export.service.js';
import { DataExportProcessor } from './data-export.processor.js';
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from './storage/export-storage.interface.js';
import { signDownloadUrl } from './signed-url.js';
import { User } from '../../../entities/user.entity.js';

describe('DataExportController', () => {
  let controller: DataExportController;
  const service = {
    requestExport: jest.fn(),
    getRequest: jest.fn(),
    findById: jest.fn(),
    buildPublicView: jest.fn((r: { id: string; status: string }) => ({
      id: r.id,
      status: r.status,
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      completedAt: null,
      downloadUrl: null,
      byteSize: null,
      errorMessage: null,
    })),
    signingSecret: () => 'test-secret',
  };
  const processor = { process: jest.fn().mockResolvedValue(undefined) };
  const storage: ExportStorage = {
    write: jest.fn(),
    read: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [DataExportController],
      providers: [
        { provide: DataExportService, useValue: service },
        { provide: DataExportProcessor, useValue: processor },
        { provide: EXPORT_STORAGE, useValue: storage },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        // AuthGuard pulls UserRepository now (post-#295) for token-aware
        // user lookups; tests don't exercise the guard but DI needs it.
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    controller = module.get(DataExportController);
  });

  it('returns 202 + dispatches worker on a fresh request', async () => {
    const req = { id: 'req-1', user_id: 'u1', status: 'queued' };
    service.requestExport.mockResolvedValue({ created: true, request: req });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await controller.create({ user: { userId: 'u1' } } as never, res as never);
    expect(service.requestExport).toHaveBeenCalledWith('u1');
    expect(res.status).toHaveBeenCalledWith(202);
    await new Promise(setImmediate);
    expect(processor.process).toHaveBeenCalledWith('req-1', 'u1');
  });

  it('returns 200 when reusing an active request', async () => {
    const req = { id: 'req-1', user_id: 'u1', status: 'ready' };
    service.requestExport.mockResolvedValue({ created: false, request: req });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await controller.create({ user: { userId: 'u1' } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    await new Promise(setImmediate);
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('GET status returns the public view', async () => {
    service.getRequest.mockResolvedValue({
      id: 'req-1',
      user_id: 'u1',
      status: 'queued',
    });
    const out = await controller.get(
      { user: { userId: 'u1' } } as never,
      'req-1',
    );
    expect(out.id).toBe('req-1');
    expect(out.status).toBe('queued');
  });

  it('GET status returns 404 when not owned by caller', async () => {
    service.getRequest.mockResolvedValue(null);
    await expect(
      controller.get({ user: { userId: 'u1' } } as never, 'req-1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('GET download streams the archive when signature is valid', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId,
      expiresAt,
      secret: 'test-secret',
    });
    service.findById.mockResolvedValue({
      id: requestId,
      user_id: 'u1',
      status: 'ready',
      storage_key: 'u1/req-1.zip',
      expires_at: new Date(expiresAt),
    });
    const stream = Readable.from(Buffer.from('zipdata'));
    (storage.read as jest.Mock).mockResolvedValue(stream);
    const writes: Buffer[] = [];
    const res = new PassThrough();
    res.on('data', (c: Buffer) => writes.push(c));
    Object.assign(res, {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    });
    await controller.download(requestId, sig, String(expiresAt), res as never);
    expect((res as unknown as { set: jest.Mock }).set).toHaveBeenCalledWith(
      'Content-Type',
      'application/zip',
    );
    expect((res as unknown as { set: jest.Mock }).set).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename="tarmoto-export-${requestId}.zip"`,
    );
    expect(Buffer.concat(writes).toString()).toBe('zipdata');
  });

  it('GET download returns 410 when storage object is missing (ENOENT)', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId,
      expiresAt,
      secret: 'test-secret',
    });
    service.findById.mockResolvedValue({
      id: requestId,
      user_id: 'u1',
      status: 'ready',
      storage_key: 'u1/req-1.zip',
      expires_at: new Date(expiresAt),
    });
    (storage.read as jest.Mock).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    await expect(
      controller.download(requestId, sig, String(expiresAt), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('GET download swallows mid-stream errors instead of crashing', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId,
      expiresAt,
      secret: 'test-secret',
    });
    service.findById.mockResolvedValue({
      id: requestId,
      user_id: 'u1',
      status: 'ready',
      storage_key: 'u1/req-1.zip',
      expires_at: new Date(expiresAt),
    });
    const erroring = new Readable({
      read() {
        this.destroy(new Error('disk eject'));
      },
    });
    (storage.read as jest.Mock).mockResolvedValue(erroring);
    const res = new PassThrough();
    Object.assign(res, {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    });
    // Must resolve cleanly — the controller logs and returns rather than
    // surfacing an unhandled rejection.
    await expect(
      controller.download(requestId, sig, String(expiresAt), res as never),
    ).resolves.toBeUndefined();
  });

  it('GET download rejects bad signature with 403', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() + 60_000;
    await expect(
      controller.download(requestId, 'badsig', String(expiresAt), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('GET download rejects expired signature with 410', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() - 1;
    const sig = signDownloadUrl({
      requestId,
      expiresAt,
      secret: 'test-secret',
    });
    await expect(
      controller.download(requestId, sig, String(expiresAt), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('GET download rejects when row is not ready', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId,
      expiresAt,
      secret: 'test-secret',
    });
    service.findById.mockResolvedValue({
      id: requestId,
      user_id: 'u1',
      status: 'processing',
      storage_key: null,
      expires_at: new Date(expiresAt),
    });
    await expect(
      controller.download(requestId, sig, String(expiresAt), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('GET download rejects missing signature with 403', async () => {
    await expect(
      controller.download('req-1', '', String(Date.now() + 60_000), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });
});
