/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PassesController } from './passes.controller.js';
import { PassesService } from './passes.service.js';
import { MountainPassDto } from './dto/passes.dto.js';

const SAMPLE_PASS: MountainPassDto = {
  id: 'pass-1',
  name: 'Stelvio Pass',
  country_code: 'IT',
  region: 'Lombardy',
  lat: 46.5285,
  lng: 10.454,
  elevation_m: 2757,
  typical_open_month: 6,
  typical_close_month: 10,
  status: 'open',
  status_overridden: false,
  notes: null,
  last_updated: '2026-04-18T00:00:00.000Z',
};

describe('PassesController', () => {
  let controller: PassesController;
  let service: jest.Mocked<PassesService>;

  beforeEach(async () => {
    const mockService: Partial<jest.Mocked<PassesService>> = {
      list: jest.fn().mockResolvedValue([SAMPLE_PASS]),
      checkRoute: jest.fn().mockResolvedValue({
        passes: [SAMPLE_PASS],
        closed_count: 0,
        unknown_count: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PassesController],
      providers: [
        { provide: PassesService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();

    controller = module.get<PassesController>(PassesController);
    service = module.get(PassesService);
  });

  it('GET /passes returns the list', async () => {
    const result = await controller.list({});
    expect(service.list).toHaveBeenCalledWith(undefined, undefined);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Stelvio Pass');
  });

  it('GET /passes forwards bbox to the service', async () => {
    await controller.list({ bbox: '5,45,17,49' });
    expect(service.list).toHaveBeenCalledWith('5,45,17,49', undefined);
  });

  it('GET /passes forwards for_month to the service', async () => {
    await controller.list({ for_month: 8 });
    expect(service.list).toHaveBeenCalledWith(undefined, 8);
  });

  it('POST /passes/check-route forwards the body and returns counts', async () => {
    const result = await controller.checkRoute({
      route: [
        { lat: 46.5, lng: 10.4 },
        { lat: 46.6, lng: 10.5 },
      ],
      buffer_m: 2000,
    });
    expect(service.checkRoute).toHaveBeenCalledWith({
      route: [
        { lat: 46.5, lng: 10.4 },
        { lat: 46.6, lng: 10.5 },
      ],
      buffer_m: 2000,
    });
    expect(result.passes).toHaveLength(1);
    expect(result.closed_count).toBe(0);
  });

  it('POST /passes/check-route forwards for_month through unchanged', async () => {
    await controller.checkRoute({
      route: [
        { lat: 46.5, lng: 10.4 },
        { lat: 46.6, lng: 10.5 },
      ],
      for_month: 2,
    });
    expect(service.checkRoute).toHaveBeenCalledWith(
      expect.objectContaining({ for_month: 2 }),
    );
  });
});
