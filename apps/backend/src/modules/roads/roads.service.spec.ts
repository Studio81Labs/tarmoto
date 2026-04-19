import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RoadsService } from './roads.service.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';

describe('RoadsService', () => {
  let service: RoadsService;
  let segmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;
  let funZoneRepo: Partial<jest.Mocked<Repository<FunZone>>>;

  beforeEach(async () => {
    segmentRepo = {
      query: jest.fn().mockResolvedValue([]),
    };
    funZoneRepo = {
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoadsService,
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(FunZone), useValue: funZoneRepo },
      ],
    }).compile();

    service = module.get<RoadsService>(RoadsService);
  });

  describe('findNearby', () => {
    it('should query with correct spatial parameters', async () => {
      await service.findNearby({ lat: 49.1, lng: 16.75 });

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        [16.75, 49.1, 5000],
      );
    });

    it('should use custom radius', async () => {
      await service.findNearby({ lat: 49.1, lng: 16.75, radius: 10000 });

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        [16.75, 49.1, 10000],
      );
    });

    it('should filter by min_quality', async () => {
      await service.findNearby({ lat: 49.1, lng: 16.75, min_quality: 3.5 });

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('quality_score >= $4'),
        [16.75, 49.1, 5000, 3.5],
      );
    });

    it('should filter by surface_type', async () => {
      await service.findNearby({
        lat: 49.1,
        lng: 16.75,
        surface_type: 'asphalt',
      });

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('surface_type = $4'),
        [16.75, 49.1, 5000, 'asphalt'],
      );
    });

    it('should apply both filters with correct param indices', async () => {
      await service.findNearby({
        lat: 49.1,
        lng: 16.75,
        min_quality: 3.0,
        surface_type: 'gravel',
      });

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('quality_score >= $4'),
        [16.75, 49.1, 5000, 3.0, 'gravel'],
      );
      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('surface_type = $5'),
        expect.any(Array),
      );
    });

    it('should map response with distance', async () => {
      segmentRepo.query!.mockResolvedValueOnce([
        {
          id: 'seg-1',
          road_name: 'D35',
          road_number: '35',
          quality_score: 4.2,
          curviness_score: 3.5,
          surface_type: 'asphalt',
          length_m: 150,
          confidence: 80,
          reading_count: 8,
          last_updated: new Date('2026-04-13T10:00:00Z'),
          distance_m: 234.56,
        },
      ]);

      const results = await service.findNearby({ lat: 49.1, lng: 16.75 });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('seg-1');
      expect(results[0].quality_score).toBe(4.2);
      expect(results[0].confidence).toBe(80);
      expect(results[0].distance_m).toBe(235);
    });
  });

  describe('findById', () => {
    it('should return detailed segment with breakdown', async () => {
      // Mock: segment query
      segmentRepo
        .query!.mockResolvedValueOnce([
          {
            id: 'seg-1',
            road_name: 'Test Road',
            road_number: null,
            quality_score: 4.0,
            curviness_score: 2.5,
            surface_type: 'asphalt',
            length_m: 200,
            confidence: 70,
            reading_count: 7,
            last_updated: new Date('2026-04-13T10:00:00Z'),
            elevation_min: 350,
            elevation_max: 420,
            geojson: {
              coordinates: [
                [16.75, 49.1],
                [16.76, 49.11],
              ],
            },
          },
        ])
        // Mock: quality breakdown
        .mockResolvedValueOnce([
          { classification: 'excellent', count: 5 },
          { classification: 'good', count: 3 },
          { classification: 'fair', count: 2 },
        ])
        // Mock: hazard count
        .mockResolvedValueOnce([{ count: 1 }])
        // Mock: review stats
        .mockResolvedValueOnce([{ count: 4, avg_rating: 4.3 }])
        // Mock: riders per month
        .mockResolvedValueOnce([{ count: 12 }]);

      const result = await service.findById('seg-1');

      expect(result.id).toBe('seg-1');
      expect(result.quality_score).toBe(4.0);
      expect(result.geometry).toEqual([
        { lat: 49.1, lng: 16.75 },
        { lat: 49.11, lng: 16.76 },
      ]);
      expect(result.quality_breakdown.excellent).toBe(50);
      expect(result.quality_breakdown.good).toBe(30);
      expect(result.quality_breakdown.fair).toBe(20);
      expect(result.quality_breakdown.poor).toBe(0);
      expect(result.active_hazards).toBe(1);
      expect(result.review_count).toBe(4);
      expect(result.avg_review_rating).toBe(4.3);
      expect(result.riders_per_month).toBe(12);
    });

    it('should throw NotFoundException for missing segment', async () => {
      segmentRepo.query!.mockResolvedValueOnce([]);

      await expect(service.findById('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should handle segment with no readings', async () => {
      segmentRepo
        .query!.mockResolvedValueOnce([
          {
            id: 'seg-2',
            road_name: null,
            road_number: null,
            quality_score: null,
            curviness_score: 1.0,
            surface_type: 'unknown',
            length_m: 100,
            confidence: 0,
            reading_count: 0,
            last_updated: new Date('2026-04-13T10:00:00Z'),
            elevation_min: null,
            elevation_max: null,
            geojson: { coordinates: [[16.75, 49.1]] },
          },
        ])
        .mockResolvedValueOnce([]) // no readings
        .mockResolvedValueOnce([{ count: 0 }]) // no hazards
        .mockResolvedValueOnce([{ count: 0, avg_rating: null }]) // no reviews
        .mockResolvedValueOnce([{ count: 0 }]); // no riders

      const result = await service.findById('seg-2');

      expect(result.quality_score).toBeNull();
      expect(result.quality_breakdown.excellent).toBe(0);
      expect(result.avg_review_rating).toBeNull();
      expect(result.riders_per_month).toBe(0);
    });
  });

  describe('findFunZones', () => {
    it('should query with bbox envelope', async () => {
      await service.findFunZones({ bbox: '18.1,49.4,18.6,49.7' });

      expect(funZoneRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('ST_MakeEnvelope'),
        [18.1, 49.4, 18.6, 49.7],
      );
    });

    it('should map boundary polygon to lat/lng array', async () => {
      funZoneRepo.query!.mockResolvedValueOnce([
        {
          id: 'fz-1',
          name: 'Beskydy',
          composite_score: 4.5,
          road_count: 25,
          total_curve_km: 120,
          avg_quality: 4.2,
          best_season: 'summer',
          geojson: {
            coordinates: [
              [
                [18.1, 49.4],
                [18.6, 49.4],
                [18.6, 49.7],
                [18.1, 49.7],
                [18.1, 49.4],
              ],
            ],
          },
        },
      ]);

      const results = await service.findFunZones({
        bbox: '18.1,49.4,18.6,49.7',
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Beskydy');
      expect(results[0].composite_score).toBe(4.5);
      expect(results[0].boundary).toHaveLength(5);
      expect(results[0].boundary[0]).toEqual({ lat: 49.4, lng: 18.1 });
    });
  });
});
