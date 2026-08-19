import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { BikesController } from './bikes.controller.js';
import { BikesService } from './bikes.service.js';
import type { BikeDto } from './dto/bike.dto.js';

describe('BikesController', () => {
  let controller: BikesController;
  let service: jest.Mocked<BikesService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const sampleBike: BikeDto = {
    id: 'bike-1',
    make: 'Honda',
    model: 'Africa Twin',
    year: 2024,
    isActive: true,
    photoUrl: null,
    icon: 'adventure',
    notes: null,
    totalKm: 0,
    totalRides: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService: Partial<jest.Mocked<BikesService>> = {
      list: jest.fn().mockResolvedValue([sampleBike]),
      getActive: jest.fn().mockResolvedValue(sampleBike),
      create: jest.fn().mockResolvedValue(sampleBike),
      update: jest.fn().mockResolvedValue(sampleBike),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BikesController],
      providers: [
        { provide: BikesService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get(BikesController);
    service = module.get(BikesService);
  });

  it('GET /account/bikes returns the rider’s bikes', async () => {
    const result = await controller.list(mockReq);

    expect(service.list).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('bike-1');
  });

  it('GET /account/bikes/active routes to the lightweight lookup', async () => {
    const result = await controller.active(mockReq);

    // Critical that the controller does NOT call the heavy `list`
    // path (which runs a stats aggregate over `rides`) — the chip
    // only needs make/model.
    expect(service.getActive).toHaveBeenCalledWith('user-1');
    expect(service.list).not.toHaveBeenCalled();
    expect(result?.id).toBe('bike-1');
  });

  it('GET /account/bikes/active returns null when the rider has no garage', async () => {
    (service.getActive as jest.Mock).mockResolvedValueOnce(null);

    const result = await controller.active(mockReq);

    expect(result).toBeNull();
  });

  it('POST /account/bikes forwards the rider id and DTO', async () => {
    const dto = { make: 'Yamaha', model: 'MT-09' };
    await controller.create(mockReq, dto);

    expect(service.create).toHaveBeenCalledWith('user-1', dto);
  });

  it('PUT /account/bikes/:id forwards id + DTO', async () => {
    const dto = { is_active: true };
    await controller.put(mockReq, 'bike-1', dto);

    expect(service.update).toHaveBeenCalledWith('user-1', 'bike-1', dto);
  });

  it('PATCH /account/bikes/:id is an alias for the same update path', async () => {
    const dto = { notes: 'service due' };
    await controller.patch(mockReq, 'bike-1', dto);

    expect(service.update).toHaveBeenCalledWith('user-1', 'bike-1', dto);
  });

  it('DELETE /account/bikes/:id forwards id + rider', async () => {
    await controller.delete(mockReq, 'bike-1');
    expect(service.delete).toHaveBeenCalledWith('user-1', 'bike-1');
  });
});
