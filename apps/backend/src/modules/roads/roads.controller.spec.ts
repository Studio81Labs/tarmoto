import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RoadsController } from './roads.controller.js';
import { RoadsService } from './roads.service.js';
import { MapillaryService } from '../mapillary/index.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';

describe('RoadsController', () => {
  let controller: RoadsController;
  let service: jest.Mocked<RoadsService>;
  let mapillary: jest.Mocked<MapillaryService>;

  const mockSegment = {
    id: 'seg-1',
    road_name: 'D35',
    road_number: '35',
    quality_score: 4.2,
    curviness_score: 3.5,
    surface_type: 'asphalt',
    length_m: 150,
    confidence: 80,
    reading_count: 8,
    last_updated: '2026-04-13T10:00:00.000Z',
    distance_m: 235,
  };

  beforeEach(async () => {
    const mockService = {
      findNearby: jest.fn().mockResolvedValue([mockSegment]),
      findById: jest.fn().mockResolvedValue({
        ...mockSegment,
        geometry: [{ lat: 49.1, lng: 16.75 }],
        elevation_min: 350,
        elevation_max: 420,
        quality_breakdown: {
          excellent: 50,
          good: 30,
          fair: 20,
          poor: 0,
          very_poor: 0,
        },
        active_hazards: 1,
        review_count: 4,
        avg_review_rating: 4.3,
        riders_per_month: 12,
      }),
      getRouteQuality: jest
        .fn()
        .mockResolvedValue({ segments: [{ osm_way_id: '1' }] }),
      findFunZones: jest.fn().mockResolvedValue([]),
      findZoneById: jest.fn().mockResolvedValue({
        zone: {
          id: 'fz-1',
          name: 'Beskydy',
          composite_score: 4.5,
          road_count: 25,
          total_curve_km: 120,
          avg_quality: 4.2,
          best_season: 'summer',
          boundary: [{ lat: 49.4, lng: 18.1 }],
        },
        top_roads: [],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RoadsController],
      providers: [
        { provide: RoadsService, useValue: mockService },
        {
          provide: MapillaryService,
          useValue: {
            segmentImagery: jest.fn().mockResolvedValue({
              imageId: null,
              capturedAt: null,
              attribution: null,
              link: null,
            }),
            thumbnail: jest.fn().mockResolvedValue(null),
          },
        },
        // `route-quality` is behind AuthGuard; provide its deps so the module
        // compiles (the unit tests call methods directly, past the guard).
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<RoadsController>(RoadsController);
    service = module.get(RoadsService);
    mapillary = module.get(MapillaryService);
  });

  describe('POST /roads/route-quality', () => {
    it('delegates the routed geometry to the service', async () => {
      const dto = {
        geometry: [
          { lat: 49.1, lng: 16.7 },
          { lat: 49.2, lng: 16.8 },
        ],
      };

      const result = await controller.getRouteQuality(dto);

      expect(service.getRouteQuality).toHaveBeenCalledWith(dto);
      expect(result.segments).toHaveLength(1);
    });

    it('is behind AuthGuard so anonymous callers cannot trigger the spatial query', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        RoadsController.prototype.getRouteQuality,
      ) as unknown[];
      expect(guards).toBeDefined();
      expect(guards).toContain(AuthGuard);
    });
  });

  describe('GET /roads/nearby', () => {
    it('should return nearby segments', async () => {
      const result = await controller.findNearby({ lat: 49.1, lng: 16.75 });

      expect(service.findNearby).toHaveBeenCalledWith({
        lat: 49.1,
        lng: 16.75,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.quality_score).toBe(4.2);
    });
  });

  describe('GET /roads/:segmentId', () => {
    it('should return segment detail', async () => {
      const result = await controller.findById('seg-1');

      expect(service.findById).toHaveBeenCalledWith('seg-1');
      expect(result.quality_breakdown.excellent).toBe(50);
      expect(result.riders_per_month).toBe(12);
    });

    it('should propagate NotFoundException', async () => {
      service.findById.mockRejectedValueOnce(new NotFoundException());

      await expect(controller.findById('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /roads/fun-zones', () => {
    it('should pass bbox to service', async () => {
      await controller.findFunZones({ bbox: '18.1,49.4,18.6,49.7' });

      expect(service.findFunZones).toHaveBeenCalledWith({
        bbox: '18.1,49.4,18.6,49.7',
      });
    });
  });

  describe('GET /roads/fun-zones/:id', () => {
    it('should delegate to findZoneById', async () => {
      const result = await controller.findZoneById('fz-1');

      expect(service.findZoneById).toHaveBeenCalledWith('fz-1');
      expect(result.zone.id).toBe('fz-1');
      expect(result.top_roads).toEqual([]);
    });

    it('should propagate NotFoundException', async () => {
      service.findZoneById.mockRejectedValueOnce(new NotFoundException());

      await expect(controller.findZoneById('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /roads/segment-imagery', () => {
    it('delegates lat/lng/bearing to the Mapillary service', async () => {
      const result = await controller.getSegmentImagery({
        lat: 46.5,
        lng: 10.4,
        bearing: 90,
      });

      expect(mapillary.segmentImagery).toHaveBeenCalledWith(46.5, 10.4, 90);
      expect(result).toEqual({
        imageId: null,
        capturedAt: null,
        attribution: null,
        link: null,
      });
    });
  });

  describe('GET /roads/segment-imagery/thumb/:imageId', () => {
    function mockRes() {
      const res = {
        set: jest.fn(),
        send: jest.fn(),
        status: jest.fn(),
        end: jest.fn(),
      };
      res.status.mockReturnValue(res);
      return res;
    }

    it('streams the proxied bytes with content-type + cache headers', async () => {
      mapillary.thumbnail.mockResolvedValueOnce({
        contentType: 'image/jpeg',
        body: Buffer.from([1, 2, 3]),
      });
      const res = mockRes();

      await controller.getSegmentImageryThumb(
        'mly-1',
        res as unknown as Parameters<
          typeof controller.getSegmentImageryThumb
        >[1],
      );

      expect(mapillary.thumbnail).toHaveBeenCalledWith('mly-1');
      expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
      // Cross-origin (companion origin ≠ API origin) — must override Helmet's
      // same-origin CORP or the browser blocks the <img>.
      expect(res.set).toHaveBeenCalledWith(
        'Cross-Origin-Resource-Policy',
        'cross-origin',
      );
      expect(res.send).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    });

    it('404s when the image has no thumbnail', async () => {
      mapillary.thumbnail.mockResolvedValueOnce(null);
      const res = mockRes();

      await controller.getSegmentImageryThumb(
        'missing',
        res as unknown as Parameters<
          typeof controller.getSegmentImageryThumb
        >[1],
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
    });
  });
});
