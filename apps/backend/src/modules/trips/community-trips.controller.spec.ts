import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { CommunityTripsController } from './community-trips.controller.js';
import { TripsService } from './trips.service.js';

describe('CommunityTripsController', () => {
  let controller: CommunityTripsController;
  let service: jest.Mocked<Pick<TripsService, 'getPublicDetail'>>;

  const tripId = '11111111-1111-1111-1111-111111111111';
  const mockReq = { user: { userId: 'user-1' } } as never;
  const anonReq = {} as never;

  const publicDetail = {
    id: tripId,
    owner_id: 'owner-1',
    owner_name: 'Adam',
    title: 'Dolomites Loop',
  } as never;

  beforeEach(async () => {
    const mockService = {
      getPublicDetail: jest.fn().mockResolvedValue(publicDetail),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommunityTripsController],
      providers: [
        { provide: TripsService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get(CommunityTripsController);
    service = module.get(TripsService);
  });

  it('threads the authenticated caller id through to the service', async () => {
    const result = await controller.getPublicDetail(mockReq, tripId);
    expect(service.getPublicDetail).toHaveBeenCalledWith('user-1', tripId);
    expect(result).toBe(publicDetail);
  });

  it('passes a null viewer id for an anonymous reader', async () => {
    await controller.getPublicDetail(anonReq, tripId);
    expect(service.getPublicDetail).toHaveBeenCalledWith(null, tripId);
  });

  it('propagates a 404 from the service unchanged', async () => {
    service.getPublicDetail.mockRejectedValueOnce(
      new NotFoundException('Trip not found'),
    );
    await expect(
      controller.getPublicDetail(anonReq, tripId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
