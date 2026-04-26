/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';
import { TripGeneratorService } from './trip-generator.service.js';

describe('TripsController', () => {
  let controller: TripsController;
  let service: jest.Mocked<TripsService>;
  let generator: jest.Mocked<TripGeneratorService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockSummary = {
    id: 'trip-1',
    title: 'Italian Loop',
    region: 'Dolomites',
    num_days: 5,
    status: 'draft',
    member_count: 1,
    created_at: '2026-04-24T10:00:00.000Z',
  };

  const mockDetail = {
    ...mockSummary,
    daily_km_min: 150,
    daily_km_max: 350,
    min_quality: 3,
    road_preference: 'curvy',
    invite_code: 'ABCDEFGH',
    members: [],
    days: [],
  };

  beforeEach(async () => {
    const mockService = {
      list: jest.fn().mockResolvedValue([mockSummary]),
      create: jest.fn().mockResolvedValue(mockDetail),
      getDetail: jest.fn().mockResolvedValue(mockDetail),
      join: jest.fn().mockResolvedValue(mockDetail),
      update: jest.fn().mockResolvedValue(mockDetail),
    };

    const mockGenerator = {
      generate: jest.fn().mockResolvedValue({
        trip: mockDetail,
        selected_option: 'best-fit',
        options: [],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TripsController],
      providers: [
        { provide: TripsService, useValue: mockService },
        { provide: TripGeneratorService, useValue: mockGenerator },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();

    controller = module.get(TripsController);
    service = module.get(TripsService);
    generator = module.get(TripGeneratorService);
  });

  it('GET /trips delegates to service.list with the caller id', async () => {
    const result = await controller.list(mockReq, { status: 'planned' });
    expect(service.list).toHaveBeenCalledWith('user-1', { status: 'planned' });
    expect(result).toHaveLength(1);
  });

  it('POST /trips creates a trip and returns the detail', async () => {
    const dto = { title: 'Italian Loop', num_days: 5 };
    const result = await controller.create(mockReq, dto);
    expect(service.create).toHaveBeenCalledWith('user-1', dto);
    expect(result.invite_code).toBe('ABCDEFGH');
  });

  it('GET /trips/:tripId returns the detail for the caller', async () => {
    const result = await controller.getDetail(mockReq, 'trip-1');
    expect(service.getDetail).toHaveBeenCalledWith('user-1', 'trip-1');
    expect(result.id).toBe('trip-1');
  });

  it('POST /trips/:tripId/join forwards the invite code to the service', async () => {
    const result = await controller.join(mockReq, 'trip-1', {
      invite_code: 'ABCDEFGH',
    });
    expect(service.join).toHaveBeenCalledWith('user-1', 'trip-1', 'ABCDEFGH');
    expect(result.id).toBe('trip-1');
  });

  it('PATCH /trips/:tripId forwards the update DTO to the service', async () => {
    const dto = { title: 'Renamed' };
    const result = await controller.update(mockReq, 'trip-1', dto);
    expect(service.update).toHaveBeenCalledWith('user-1', 'trip-1', dto);
    expect(result.id).toBe('trip-1');
  });

  it('POST /trips/:tripId/generate forwards the DTO to the generator', async () => {
    const dto = {
      start_location: { lat: 47.0, lng: 11.5 },
      option: 'scenic' as const,
    };
    const result = await controller.generate(mockReq, 'trip-1', dto);
    expect(generator.generate).toHaveBeenCalledWith('user-1', 'trip-1', dto);
    expect(result.selected_option).toBe('best-fit');
  });
});
