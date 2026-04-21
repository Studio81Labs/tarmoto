/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RoadsController } from './roads.controller.js';
import { RoadsService } from './roads.service.js';

describe('RoadsController', () => {
  let controller: RoadsController;
  let service: jest.Mocked<RoadsService>;

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
      providers: [{ provide: RoadsService, useValue: mockService }],
    }).compile();

    controller = module.get<RoadsController>(RoadsController);
    service = module.get(RoadsService);
  });

  describe('GET /roads/nearby', () => {
    it('should return nearby segments', async () => {
      const result = await controller.findNearby({ lat: 49.1, lng: 16.75 });

      expect(service.findNearby).toHaveBeenCalledWith({
        lat: 49.1,
        lng: 16.75,
      });
      expect(result).toHaveLength(1);
      expect(result[0].quality_score).toBe(4.2);
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
});
