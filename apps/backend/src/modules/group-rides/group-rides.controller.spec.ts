import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
import { GroupRidesController } from './group-rides.controller.js';
import { GroupRidesService } from './group-rides.service.js';

describe('GroupRidesController', () => {
  let controller: GroupRidesController;
  let service: jest.Mocked<GroupRidesService>;

  const RIDE_ID = '11111111-1111-1111-1111-111111111111';
  const mockReq = { user: { userId: 'user-1' } } as never;

  const detail = {
    id: RIDE_ID,
    owner_id: 'user-1',
    name: 'Sunday Loop',
    code: 'AB23CD',
    started_at: '2026-04-30T10:00:00.000Z',
    ended_at: null,
    members: [],
  };

  beforeEach(async () => {
    const mockService = {
      create: jest.fn().mockResolvedValue(detail),
      join: jest.fn().mockResolvedValue(detail),
      leave: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      getDetail: jest.fn().mockResolvedValue(detail),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupRidesController],
      providers: [
        { provide: GroupRidesService, useValue: mockService },
        ...authGuardTestProviders,
        ...featureGuardTestProviders,
      ],
    }).compile();

    controller = module.get(GroupRidesController);
    service = module.get(GroupRidesService);
  });

  it('POST /group-rides forwards the body to service.create', async () => {
    const result = await controller.create(mockReq, { name: 'Sunday Loop' });
    expect(service.create).toHaveBeenCalledWith('user-1', {
      name: 'Sunday Loop',
    });
    expect(result.code).toBe('AB23CD');
  });

  it('POST /group-rides/:code/join forwards the code', async () => {
    await controller.join(mockReq, 'AB23CD');
    expect(service.join).toHaveBeenCalledWith('user-1', 'AB23CD');
  });

  it('POST /group-rides/:id/leave delegates to service.leave', async () => {
    await controller.leave(mockReq, RIDE_ID);
    expect(service.leave).toHaveBeenCalledWith('user-1', RIDE_ID);
  });

  it('POST /group-rides/:id/end delegates to service.end', async () => {
    await controller.end(mockReq, RIDE_ID);
    expect(service.end).toHaveBeenCalledWith('user-1', RIDE_ID);
  });

  it('GET /group-rides/:id delegates to service.getDetail', async () => {
    const result = await controller.getDetail(mockReq, RIDE_ID);
    expect(service.getDetail).toHaveBeenCalledWith('user-1', RIDE_ID);
    expect(result.id).toBe(RIDE_ID);
  });
});
