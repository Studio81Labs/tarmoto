import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataExportService } from './data-export.service.js';
import { DataExportRequest } from '../../../entities/data-export-request.entity.js';
import { OBJECT_STORAGE } from '../../storage/storage.tokens.js';

describe('DataExportService', () => {
  let service: DataExportService;
  const repo = {
    findOne: jest.fn(),
    create: jest.fn((x: Partial<DataExportRequest>) => ({ ...x })),
    save: jest.fn((x: Partial<DataExportRequest>) =>
      Promise.resolve({
        ...x,
        id: x.id ?? 'req-new',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ),
    update: jest.fn(),
  };
  const storage = {
    put: jest.fn(),
    read: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(true),
    publicUrl: jest.fn(),
    signedUrl: jest.fn(),
  };
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'TARMOTO_EXPORT_SIGNING_SECRET') return 'test-secret';
      if (k === 'TARMOTO_PUBLIC_BASE_URL') return 'https://api.example.com';
      return undefined;
    }),
  };

  beforeEach(async () => {
    repo.findOne.mockReset();
    repo.save.mockReset();
    repo.save.mockImplementation((x: Partial<DataExportRequest>) =>
      Promise.resolve({
        ...x,
        id: x.id ?? 'req-new',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    );
    repo.update.mockReset();
    repo.update.mockResolvedValue({ affected: 1, raw: [] });
    repo.create.mockClear();
    storage.delete.mockClear();
    storage.exists.mockReset();
    storage.exists.mockResolvedValue(true);
    const module = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: getRepositoryToken(DataExportRequest), useValue: repo },
        { provide: ConfigService, useValue: config },
        { provide: OBJECT_STORAGE, useValue: storage },
      ],
    }).compile();
    service = module.get(DataExportService);
  });

  it('creates a new request when none active', async () => {
    repo.findOne.mockResolvedValue(null);
    const out = await service.requestExport('u1');
    expect(out.created).toBe(true);
    expect(repo.save).toHaveBeenCalled();
    expect(out.request.user_id).toBe('u1');
    expect(out.request.status).toBe('queued');
    expect(out.request.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns the existing request when one is active', async () => {
    const existing = {
      id: 'req-1',
      user_id: 'u1',
      status: 'processing',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      storage_key: null,
      byte_size: null,
      error_message: null,
    } as DataExportRequest;
    repo.findOne.mockResolvedValue(existing);
    const out = await service.requestExport('u1');
    expect(out.created).toBe(false);
    expect(out.request.id).toBe('req-1');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('regenerates when an in-TTL ready row has lost its file on disk', async () => {
    const liveButOrphaned = {
      id: 'req-orphan',
      user_id: 'u1',
      status: 'ready',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: new Date(),
      storage_key: 'u1/req-orphan.zip',
      byte_size: '100',
      error_message: null,
    } as DataExportRequest;
    repo.findOne.mockResolvedValue(liveButOrphaned);
    storage.exists.mockResolvedValueOnce(false);
    const out = await service.requestExport('u1');
    expect(storage.exists).toHaveBeenCalledWith('u1/req-orphan.zip');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-orphan' },
      { status: 'expired' },
    );
    expect(out.created).toBe(true);
  });

  it('treats a transient storage.exists failure as reachable (no false-eviction)', async () => {
    const liveRow = {
      id: 'req-ok',
      user_id: 'u1',
      status: 'ready',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: new Date(),
      storage_key: 'u1/req-ok.zip',
      byte_size: '100',
      error_message: null,
    } as DataExportRequest;
    repo.findOne.mockResolvedValue(liveRow);
    storage.exists.mockRejectedValueOnce(new Error('s3 503'));
    const out = await service.requestExport('u1');
    expect(out.created).toBe(false);
    expect(out.request.id).toBe('req-ok');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it.each(['queued', 'processing'] as const)(
    'regenerates when a %s row has been stuck for >30min (worker is dead)',
    async (status) => {
      const stuck = {
        id: 'req-stuck',
        user_id: 'u1',
        status,
        expires_at: new Date(Date.now() + 24 * 60 * 60_000),
        created_at: new Date(Date.now() - 60 * 60_000),
        updated_at: new Date(Date.now() - 60 * 60_000),
        completed_at: null,
        storage_key: null,
        byte_size: null,
        error_message: null,
      } as DataExportRequest;
      repo.findOne.mockResolvedValue(stuck);
      const out = await service.requestExport('u1');
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'req-stuck' },
        { status: 'expired' },
      );
      expect(out.created).toBe(true);
    },
  );

  it.each(['queued', 'processing'] as const)(
    'reuses a fresh %s row that the worker is still plausibly running',
    async (status) => {
      const fresh = {
        id: 'req-fresh',
        user_id: 'u1',
        status,
        expires_at: new Date(Date.now() + 24 * 60 * 60_000),
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        storage_key: null,
        byte_size: null,
        error_message: null,
      } as DataExportRequest;
      repo.findOne.mockResolvedValue(fresh);
      const out = await service.requestExport('u1');
      expect(out.created).toBe(false);
      expect(out.request.id).toBe('req-fresh');
      expect(repo.update).not.toHaveBeenCalled();
    },
  );

  it('expires + deletes the old file when the previous row is past TTL', async () => {
    const expired = {
      id: 'req-old',
      user_id: 'u1',
      status: 'ready',
      expires_at: new Date(Date.now() - 1),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: new Date(),
      storage_key: 'u1/req-old.zip',
      byte_size: '100',
      error_message: null,
    } as DataExportRequest;
    repo.findOne.mockResolvedValue(expired);
    const out = await service.requestExport('u1');
    expect(storage.delete).toHaveBeenCalledWith('u1/req-old.zip');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-old' },
      { status: 'expired' },
    );
    expect(repo.save).toHaveBeenCalled();
    expect(out.created).toBe(true);
  });

  it('still expires the row when the storage delete fails', async () => {
    const expired = {
      id: 'req-old',
      user_id: 'u1',
      status: 'ready',
      expires_at: new Date(Date.now() - 1),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: new Date(),
      storage_key: 'u1/req-old.zip',
      byte_size: '100',
      error_message: null,
    } as DataExportRequest;
    repo.findOne.mockResolvedValue(expired);
    storage.delete.mockRejectedValueOnce(new Error('disk gone'));
    const out = await service.requestExport('u1');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-old' },
      { status: 'expired' },
    );
    expect(out.created).toBe(true);
  });

  it('returns the winner when a concurrent insert wins the unique race', async () => {
    repo.findOne.mockResolvedValueOnce(null);
    repo.save.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );
    const winner = {
      id: 'req-winner',
      user_id: 'u1',
      status: 'queued',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      storage_key: null,
      byte_size: null,
      error_message: null,
    } as DataExportRequest;
    repo.findOne.mockResolvedValueOnce(winner);
    const out = await service.requestExport('u1');
    expect(out.created).toBe(false);
    expect(out.request.id).toBe('req-winner');
  });

  it('rethrows non-unique-violation errors from save', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.requestExport('u1')).rejects.toThrow(
      'connection lost',
    );
  });

  it('emits a signed download URL when status is ready', () => {
    const req = {
      id: 'req-1',
      user_id: 'u1',
      status: 'ready',
      storage_key: 'u1/req-1.zip',
      byte_size: '123',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: new Date(),
      error_message: null,
    } as DataExportRequest;
    const view = service.buildPublicView(req);
    expect(view.downloadUrl).toMatch(
      /^https:\/\/api\.example\.com\/api\/v1\/account\/data-export\/req-1\/download\?sig=[a-f0-9]+&exp=\d+$/,
    );
    expect(view.byteSize).toBe(123);
  });

  it('reports a ready row past its TTL as expired with no download URL', () => {
    const req = {
      id: 'req-stale',
      user_id: 'u1',
      status: 'ready',
      storage_key: 'u1/req-stale.zip',
      byte_size: '123',
      expires_at: new Date(Date.now() - 1),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: new Date(),
      error_message: null,
    } as DataExportRequest;
    const view = service.buildPublicView(req);
    expect(view.status).toBe('expired');
    expect(view.downloadUrl).toBeNull();
  });

  it.each(['queued', 'processing'] as const)(
    'reports a %s row past its TTL as expired so polling can exit',
    (status) => {
      const req = {
        id: 'req-stuck',
        user_id: 'u1',
        status,
        storage_key: null,
        byte_size: null,
        expires_at: new Date(Date.now() - 1),
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        error_message: null,
      } as DataExportRequest;
      const view = service.buildPublicView(req);
      expect(view.status).toBe('expired');
      expect(view.downloadUrl).toBeNull();
    },
  );

  it('keeps a failed row as failed even past its TTL', () => {
    const req = {
      id: 'req-failed',
      user_id: 'u1',
      status: 'failed',
      storage_key: null,
      byte_size: null,
      expires_at: new Date(Date.now() - 1),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      error_message: 'boom',
    } as DataExportRequest;
    const view = service.buildPublicView(req);
    expect(view.status).toBe('failed');
    expect(view.errorMessage).toBe('boom');
  });

  it('omits download URL for non-ready statuses', () => {
    for (const status of [
      'queued',
      'processing',
      'failed',
      'expired',
    ] as const) {
      const req = {
        id: 'req-1',
        user_id: 'u1',
        status,
        storage_key: null,
        byte_size: null,
        expires_at: new Date(Date.now() + 60_000),
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        error_message: null,
      } as DataExportRequest;
      const view = service.buildPublicView(req);
      expect(view.downloadUrl).toBeNull();
      expect(view.status).toBe(status);
    }
  });

  it('throws when signing secret is missing', () => {
    config.get.mockImplementationOnce(() => undefined);
    expect(() => service.signingSecret()).toThrow(/SIGNING_SECRET/);
  });

  it('markProcessing is a conditional update on status=queued and reports affected', async () => {
    repo.update.mockResolvedValueOnce({ affected: 1, raw: [] });
    const claimed = await service.markProcessing('req-1');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-1', status: 'queued' },
      { status: 'processing' },
    );
    expect(claimed).toBe(true);
  });

  it('markProcessing returns false when the row is no longer queued', async () => {
    repo.update.mockResolvedValueOnce({ affected: 0, raw: [] });
    const claimed = await service.markProcessing('req-1');
    expect(claimed).toBe(false);
  });

  it('markReady is a conditional update on status=processing', async () => {
    repo.update.mockResolvedValueOnce({ affected: 1, raw: [] });
    await service.markReady('req-1', 'u1/req-1.zip', 999);
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-1', status: 'processing' },
      expect.objectContaining({
        status: 'ready',
        storage_key: 'u1/req-1.zip',
        byte_size: '999',
      }),
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('markReady deletes the orphan ZIP when the row was already moved off processing', async () => {
    repo.update.mockResolvedValueOnce({ affected: 0, raw: [] });
    await service.markReady('req-1', 'u1/req-1.zip', 999);
    expect(storage.delete).toHaveBeenCalledWith('u1/req-1.zip');
  });

  it('markFailed is a conditional update on status=processing', async () => {
    await service.markFailed('req-1', 'boom');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-1', status: 'processing' },
      expect.objectContaining({ status: 'failed', error_message: 'boom' }),
    );
  });

  it('markFailed clamps long messages', async () => {
    const longMsg = 'x'.repeat(5000);
    await service.markFailed('req-1', longMsg);
    const calls = repo.update.mock.calls as unknown as Array<
      [unknown, { error_message: string }]
    >;
    const args = calls[0]![1];
    expect(args.error_message.length).toBeLessThanOrEqual(1000);
    expect(args.error_message.startsWith('xxxx')).toBe(true);
  });

  it('markEnqueueFailed transitions queued -> failed (not processing) so a fresh POST recovers immediately', async () => {
    // Distinct from markFailed which targets the in-flight worker
    // path — this one rolls back a row whose enqueue failed before
    // the worker ever saw it.
    await service.markEnqueueFailed('req-1', 'enqueue failed: ECONNREFUSED');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-1', status: 'queued' },
      expect.objectContaining({
        status: 'failed',
        error_message: 'enqueue failed: ECONNREFUSED',
      }),
    );
  });
});
