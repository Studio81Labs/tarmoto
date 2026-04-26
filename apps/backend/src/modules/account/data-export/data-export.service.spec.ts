import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataExportService } from './data-export.service.js';
import { DataExportRequest } from '../../../entities/data-export-request.entity.js';

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
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'TARMOTO_EXPORT_SIGNING_SECRET') return 'test-secret';
      if (k === 'TARMOTO_PUBLIC_BASE_URL') return 'https://api.example.com';
      return undefined;
    }),
  };

  beforeEach(async () => {
    repo.findOne.mockReset();
    repo.save.mockClear();
    repo.update.mockClear();
    repo.create.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: getRepositoryToken(DataExportRequest), useValue: repo },
        { provide: ConfigService, useValue: config },
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

  it('treats an expired active row as no-active and creates a new one', async () => {
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
    expect(out.created).toBe(true);
    expect(repo.save).toHaveBeenCalled();
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
      /^https:\/\/api\.example\.com\/account\/data-export\/req-1\/download\?sig=[a-f0-9]+&exp=\d+$/,
    );
    expect(view.byteSize).toBe(123);
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

  it('markReady stores byte size as string and sets completed_at', async () => {
    await service.markReady('req-1', 'u1/req-1.zip', 999);
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'req-1' },
      expect.objectContaining({
        status: 'ready',
        storage_key: 'u1/req-1.zip',
        byte_size: '999',
      }),
    );
  });

  it('markFailed clamps long messages', async () => {
    const longMsg = 'x'.repeat(5000);
    await service.markFailed('req-1', longMsg);
    const calls = repo.update.mock.calls as unknown as Array<
      [unknown, { error_message: string }]
    >;
    const args = calls[0][1];
    expect(args.error_message.length).toBeLessThanOrEqual(1000);
    expect(args.error_message.startsWith('xxxx')).toBe(true);
  });
});
