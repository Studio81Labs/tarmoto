import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { TripFoldersController } from './trip-folders.controller.js';
import { TripFoldersService } from './trip-folders.service.js';

describe('TripFoldersController', () => {
  let controller: TripFoldersController;
  let service: jest.Mocked<TripFoldersService>;

  const mockReq = { user: { userId: 'user-1' } } as never;
  const folderId = '00000000-0000-0000-0000-000000000001';

  const folder = {
    id: folderId,
    user_id: 'user-1',
    name: 'Summer 2026 Alps',
    color: '#22d3ee',
    position: 0,
    created_at: '2026-04-20T10:00:00.000Z',
    updated_at: '2026-04-20T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      list: jest.fn().mockResolvedValue({ items: [folder], total: 1 }),
      create: jest.fn().mockResolvedValue(folder),
      update: jest.fn().mockResolvedValue(folder),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TripFoldersController],
      providers: [
        { provide: TripFoldersService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get(TripFoldersController);
    service = module.get(TripFoldersService);
  });

  it('GET /trip-folders forwards the caller userId to list()', async () => {
    const result = await controller.list(mockReq);
    expect(service.list).toHaveBeenCalledWith('user-1');
    expect(result.total).toBe(1);
  });

  it('POST /trip-folders forwards the dto to create()', async () => {
    const result = await controller.create(mockReq, {
      name: 'Spring Loops',
      color: '#22d3ee',
    });
    expect(service.create).toHaveBeenCalledWith('user-1', {
      name: 'Spring Loops',
      color: '#22d3ee',
    });
    expect(result.id).toBe(folderId);
  });

  it('PATCH /trip-folders/:id forwards the partial dto', async () => {
    await controller.update(mockReq, folderId, {
      name: 'Renamed',
      position: 2,
    });
    expect(service.update).toHaveBeenCalledWith('user-1', folderId, {
      name: 'Renamed',
      position: 2,
    });
  });

  it('DELETE /trip-folders/:id resolves to no content', async () => {
    await expect(controller.remove(mockReq, folderId)).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith('user-1', folderId);
  });
});
