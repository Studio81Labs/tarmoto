import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { ClosuresController } from './closures.controller.js';
import { ClosuresService } from './closures.service.js';
import { RoadClosureDto } from './dto/closures.dto.js';

const SAMPLE: RoadClosureDto = {
  id: 'closure-1',
  title: 'Rockfall on Road 44',
  reason: 'closure',
  severity: 'full',
  geometry: [
    { lng: 17.12, lat: 50.11 },
    { lng: 17.13, lat: 50.12 },
  ],
  detour: null,
  country_code: 'CZ',
  region: 'Olomouc',
  starts_at: '2026-04-20T00:00:00.000Z',
  ends_at: '2026-05-20T00:00:00.000Z',
  notes: null,
  source: 'operator',
  created_by: 'user-1',
  created_at: '2026-04-20T00:00:00.000Z',
  updated_at: '2026-04-20T00:00:00.000Z',
};

describe('ClosuresController', () => {
  let controller: ClosuresController;
  let service: jest.Mocked<ClosuresService>;

  beforeEach(async () => {
    const mockService: Partial<jest.Mocked<ClosuresService>> = {
      list: jest.fn().mockResolvedValue([SAMPLE]),
      getById: jest.fn().mockResolvedValue(SAMPLE),
      create: jest.fn().mockResolvedValue(SAMPLE),
      update: jest
        .fn()
        .mockResolvedValue({ ...SAMPLE, title: 'Updated title' }),
      remove: jest.fn().mockResolvedValue(undefined),
      checkRoute: jest.fn().mockResolvedValue({
        closures: [SAMPLE],
        full_count: 1,
        partial_count: 0,
        advisory_count: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClosuresController],
      providers: [
        { provide: ClosuresService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get(ClosuresController);
    service = module.get(ClosuresService);
  });

  it('GET /closures forwards the query to the service', async () => {
    const result = await controller.list({
      bbox: '5,45,17,49',
      severity: 'full',
    });
    expect(service.list).toHaveBeenCalledWith({
      bbox: '5,45,17,49',
      severity: 'full',
    });
    expect(result).toHaveLength(1);
  });

  it('GET /closures/:id returns the DTO', async () => {
    const result = await controller.getById(SAMPLE.id);
    expect(service.getById).toHaveBeenCalledWith(SAMPLE.id);
    expect(result.id).toBe(SAMPLE.id);
  });

  it('POST /closures calls create with the user id', async () => {
    const req = { user: { userId: 'user-1' } } as unknown as Parameters<
      ClosuresController['create']
    >[0];
    const dto = {
      title: 'Test',
      reason: 'closure' as const,
      severity: 'full' as const,
      geometry: [
        { lat: 50, lng: 17 },
        { lat: 50.1, lng: 17.1 },
      ],
      country_code: 'CZ',
      starts_at: '2026-05-01T00:00:00Z',
    };
    await controller.create(req, dto);
    expect(service.create).toHaveBeenCalledWith('user-1', dto);
  });

  it('PATCH /closures/:id calls update with creator id', async () => {
    const req = { user: { userId: 'user-1' } } as unknown as Parameters<
      ClosuresController['update']
    >[0];
    const result = await controller.update(req, SAMPLE.id, {
      title: 'Updated title',
    });
    expect(service.update).toHaveBeenCalledWith(SAMPLE.id, 'user-1', {
      title: 'Updated title',
    });
    expect(result.title).toBe('Updated title');
  });

  it('DELETE /closures/:id forwards to remove', async () => {
    const req = { user: { userId: 'user-1' } } as unknown as Parameters<
      ClosuresController['remove']
    >[0];
    await controller.remove(req, SAMPLE.id);
    expect(service.remove).toHaveBeenCalledWith(SAMPLE.id, 'user-1');
  });

  it('POST /closures/check-route forwards the body and returns counts', async () => {
    const dto = {
      route: [
        { lat: 50, lng: 17 },
        { lat: 50.1, lng: 17.1 },
      ],
      buffer_m: 150,
      active_on: '2026-05-01T00:00:00Z',
    };
    const result = await controller.checkRoute(dto);
    expect(service.checkRoute).toHaveBeenCalledWith(dto);
    expect(result.closures).toHaveLength(1);
    expect(result.full_count).toBe(1);
    expect(result.partial_count).toBe(0);
    expect(result.advisory_count).toBe(0);
  });
});
