import { Test, TestingModule } from '@nestjs/testing';
import { TilesController } from './tiles.controller.js';
import { TilesService } from './tiles.service.js';

describe('TilesController', () => {
  let controller: TilesController;
  let service: jest.Mocked<TilesService>;

  beforeEach(async () => {
    const mockService = {
      getTile: jest.fn().mockResolvedValue(Buffer.from('mvt-data')),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TilesController],
      providers: [{ provide: TilesService, useValue: mockService }],
    }).compile();

    controller = module.get<TilesController>(TilesController);
    service = module.get(TilesService);
  });

  describe('GET /roads/tiles/:z/:x/:y.mvt', () => {
    it('should return MVT with correct headers', async () => {
      const res = {
        set: jest.fn(),
        send: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      } as never;

      await controller.getTile({ z: 10, x: 550, y: 335 }, {}, res);

      expect(service.getTile).toHaveBeenCalledWith(10, 550, 335, 'all');
      expect((res as { set: jest.Mock }).set).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.mapbox-vector-tile',
      );
      expect((res as { set: jest.Mock }).set).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=300',
      );
      expect((res as { set: jest.Mock }).set).toHaveBeenCalledWith(
        'CDN-Cache-Control',
        'public, max-age=900, stale-while-revalidate=86400',
      );
      expect((res as { send: jest.Mock }).send).toHaveBeenCalled();
    });

    it('should return 204 for empty tile', async () => {
      service.getTile.mockResolvedValueOnce(null);

      const res = {
        set: jest.fn(),
        send: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      } as never;

      await controller.getTile({ z: 10, x: 550, y: 335 }, {}, res);

      expect((res as { status: jest.Mock }).status).toHaveBeenCalledWith(204);
      expect((res as { set: jest.Mock }).set).toHaveBeenCalledWith(
        'CDN-Cache-Control',
        'public, max-age=900, stale-while-revalidate=86400',
      );
      expect((res as { end: jest.Mock }).end).toHaveBeenCalled();
    });

    it('should pass layers query parameter', async () => {
      const res = {
        set: jest.fn(),
        send: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      } as never;

      await controller.getTile(
        { z: 10, x: 550, y: 335 },
        { layers: 'quality' },
        res,
      );

      expect(service.getTile).toHaveBeenCalledWith(10, 550, 335, 'quality');
    });

    it('should not mark a tile-generation error as cacheable', async () => {
      service.getTile.mockRejectedValueOnce(new Error('PostGIS unavailable'));
      const res = {
        set: jest.fn(),
        send: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      } as never;

      await expect(
        controller.getTile({ z: 10, x: 550, y: 335 }, {}, res),
      ).rejects.toThrow('PostGIS unavailable');

      expect((res as { set: jest.Mock }).set).not.toHaveBeenCalledWith(
        'Cache-Control',
        expect.anything(),
      );
      expect((res as { set: jest.Mock }).set).not.toHaveBeenCalledWith(
        'CDN-Cache-Control',
        expect.anything(),
      );
    });
  });
});
