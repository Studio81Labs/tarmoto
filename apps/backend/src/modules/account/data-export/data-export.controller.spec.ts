import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PassThrough, Readable } from 'node:stream';
import { DataExportController } from './data-export.controller.js';
import { DataExportService } from './data-export.service.js';
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from './storage/export-storage.interface.js';
import { signDownloadUrl } from './signed-url.js';
import { User } from '../../../entities/user.entity.js';
import { QUEUE_NAMES, JOB_NAMES } from '../../jobs/jobs.constants.js';

describe('DataExportController', () => {
  let controller: DataExportController;
  const service = {
    requestExport: jest.fn(),
    getRequest: jest.fn(),
    findById: jest.fn(),
    markEnqueueFailed: jest.fn().mockResolvedValue(undefined),
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
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
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
        {
          provide: getQueueToken(QUEUE_NAMES.DATA_EXPORT),
          useValue: queue,
        },
        { provide: EXPORT_STORAGE, useValue: storage },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        // AuthGuard pulls UserRepository now (post-#295) for token-aware
        // user lookups; tests don't exercise the guard but DI needs it.
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
      ],
    }).compile();
    controller = module.get(DataExportController);
  });

  it('returns 202 + enqueues worker on a fresh request', async () => {
    const req = { id: 'req-1', user_id: 'u1', status: 'queued' };
    service.requestExport.mockResolvedValue({ created: true, request: req });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await controller.create({ user: { userId: 'u1' } } as never, res as never);
    expect(service.requestExport).toHaveBeenCalledWith('u1');
    expect(res.status).toHaveBeenCalledWith(202);
    expect(queue.add).toHaveBeenCalledWith(
      JOB_NAMES.DATA_EXPORT_PROCESS,
      { request_id: 'req-1', user_id: 'u1' },
      expect.objectContaining({ jobId: 'data-export:req-1' }),
    );
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
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns 503 + marks the row failed when the queue is unreachable so the next POST recovers', async () => {
    // Without the rollback, the freshly-saved row sits in 'queued'
    // with no actual job in Redis. Subsequent POSTs within the
    // 30-minute "stuck worker" threshold see the row as still-active
    // and skip the enqueue branch — user blocked for half an hour.
    const req = { id: 'req-1', user_id: 'u1', status: 'queued' };
    service.requestExport.mockResolvedValue({ created: true, request: req });
    queue.add.mockRejectedValueOnce(new Error('ECONNREFUSED localhost:6379'));
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    await controller.create({ user: { userId: 'u1' } } as never, res as never);
    expect(service.markEnqueueFailed).toHaveBeenCalledWith(
      'req-1',
      expect.stringContaining('ECONNREFUSED'),
    );
    expect(res.set).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('still returns 503 when the rollback markEnqueueFailed itself fails (DB also flaky)', async () => {
    // Defensive: don't crash if both Redis and Postgres are degraded.
    // The user still sees 503 (so they retry); the row stays in
    // 'queued' but the legacy 30-minute stuck-worker TTL kicks in
    // eventually.
    const req = { id: 'req-1', user_id: 'u1', status: 'queued' };
    service.requestExport.mockResolvedValue({ created: true, request: req });
    queue.add.mockRejectedValueOnce(new Error('queue down'));
    service.markEnqueueFailed.mockRejectedValueOnce(new Error('db down'));
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    await expect(
      controller.create({ user: { userId: 'u1' } } as never, res as never),
    ).resolves.toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(503);
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
      userId: 'u1',
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
      userId: 'u1',
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
      userId: 'u1',
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
    service.findById.mockResolvedValue({
      id: requestId,
      user_id: 'u1',
      status: 'ready',
      storage_key: 'u1/req-1.zip',
      expires_at: new Date(expiresAt),
    });
    await expect(
      controller.download(requestId, 'badsig', String(expiresAt), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('GET download rejects a signature signed for a different user with 403', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() + 60_000;
    // Attacker signs with their own user id but points the URL at the
    // victim's request id.
    const sigForAttacker = signDownloadUrl({
      userId: 'attacker',
      requestId,
      expiresAt,
      secret: 'test-secret',
    });
    service.findById.mockResolvedValue({
      id: requestId,
      user_id: 'victim',
      status: 'ready',
      storage_key: 'victim/req-1.zip',
      expires_at: new Date(expiresAt),
    });
    await expect(
      controller.download(requestId, sigForAttacker, String(expiresAt), {
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
      userId: 'u1',
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

  it('GET download rejects when row is not ready (folded into 403 to avoid existence-leak)', async () => {
    const requestId = 'req-1';
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      userId: 'u1',
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
    ).rejects.toMatchObject({ status: 403 });
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
