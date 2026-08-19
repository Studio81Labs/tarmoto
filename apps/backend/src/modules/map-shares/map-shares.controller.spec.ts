import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { MapSharesController } from './map-shares.controller.js';
import { MapSharesService } from './map-shares.service.js';

describe('MapSharesController', () => {
  let controller: MapSharesController;
  let service: jest.Mocked<MapSharesService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockCreated = {
    id: 'share-1',
    share_token: 'a'.repeat(32),
    share_url: `/rides/road-map/shared/${'a'.repeat(32)}`,
    title: 'My explored Czechia',
    view_count: 0,
    created_at: '2026-04-25T10:00:00.000Z',
    updated_at: '2026-04-25T10:00:00.000Z',
  };

  const mockPublic = {
    share_token: 'a'.repeat(32),
    title: 'My explored Czechia',
    owner_name: 'Jane Rider',
    snapshot: { ridden_segments: 1234, segments: [] },
    view_count: 4,
    created_at: '2026-04-25T10:00:00.000Z',
    updated_at: '2026-04-25T10:00:00.000Z',
  };

  const mockListed = {
    items: [
      {
        id: 'share-1',
        share_token: 'a'.repeat(32),
        share_url: `/rides/road-map/shared/${'a'.repeat(32)}`,
        title: 'My explored Czechia',
        view_count: 4,
        created_at: '2026-04-25T10:00:00.000Z',
        updated_at: '2026-04-25T10:00:00.000Z',
      },
    ],
    total: 1,
  };

  beforeEach(async () => {
    const mockService = {
      create: jest.fn().mockResolvedValue(mockCreated),
      getByToken: jest.fn().mockResolvedValue(mockPublic),
      listMine: jest.fn().mockResolvedValue(mockListed),
      revoke: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MapSharesController],
      providers: [
        { provide: MapSharesService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<MapSharesController>(MapSharesController);
    service = module.get(MapSharesService);
  });

  it('POST /map-shares creates a share for the authenticated caller', async () => {
    const result = await controller.create(mockReq, {
      title: 'My explored Czechia',
      snapshot: { ridden_segments: 1234, segments: [] },
    });

    expect(service.create).toHaveBeenCalledWith('user-1', {
      title: 'My explored Czechia',
      snapshot: { ridden_segments: 1234, segments: [] },
    });
    expect(result.share_token).toBe('a'.repeat(32));
  });

  it("GET /map-shares/mine lists only the caller's shares", async () => {
    const result = await controller.listMine(mockReq);

    expect(service.listMine).toHaveBeenCalledWith('user-1');
    expect(result.total).toBe(1);
  });

  it('GET /map-shares/:token returns the public snapshot', async () => {
    const result = await controller.getByToken('a'.repeat(32));

    expect(service.getByToken).toHaveBeenCalledWith('a'.repeat(32));
    expect(result.owner_name).toBe('Jane Rider');
    expect(result.snapshot).toEqual({ ridden_segments: 1234, segments: [] });
  });

  it('DELETE /map-shares/:id revokes the share for the owner', async () => {
    await controller.revoke(mockReq, '00000000-0000-0000-0000-000000000001');

    expect(service.revoke).toHaveBeenCalledWith(
      'user-1',
      '00000000-0000-0000-0000-000000000001',
    );
  });
});
