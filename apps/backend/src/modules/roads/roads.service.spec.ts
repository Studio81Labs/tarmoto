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
    it('should return detailed segment with breakdown, hazards and reviews', async () => {
      const hazardCreatedAt = new Date('2026-04-14T08:00:00Z');
      const hazardExpiresAt = new Date('2026-04-21T08:00:00Z');
      const reviewCreatedAt = new Date('2026-04-12T15:30:00Z');
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
            elevation_profile: [350, 380, 420],
            geojson: {
              coordinates: [
                [16.75, 49.1],
                [16.755, 49.105],
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
        // Mock: active hazard count
        .mockResolvedValueOnce([{ count: 1 }])
        // Mock: active hazard rows (top N)
        .mockResolvedValueOnce([
          {
            id: 'h-1',
            hazard_type: 'pothole',
            severity: 'high',
            note: 'Big crater',
            confirmations: 3,
            created_at: hazardCreatedAt,
            expires_at: hazardExpiresAt,
            lng: 16.755,
            lat: 49.105,
            reporter: 'Jane Rider',
            road_name: 'Test Road',
          },
        ])
        // Mock: review stats
        .mockResolvedValueOnce([{ count: 4, avg_rating: 4.3 }])
        // Mock: review rows (top N). The mapper now also reads
        // `user_id`, `user_join_id`, and `user_deleted_at` so it can
        // mask both `user_id` and the byline when the author has been
        // soft-deleted (#335).
        .mockResolvedValueOnce([
          {
            id: 'r-1',
            rating: 5,
            comment: 'Smooth tarmac',
            bike_model: 'Ducati Monster',
            photos: ['https://media.tarmoto.app/r/abc.jpg'],
            created_at: reviewCreatedAt,
            user_id: 'user-1',
            user_join_id: 'user-1',
            user_deleted_at: null,
            display_name: 'John Rider',
          },
        ])
        // Mock: riders per month
        .mockResolvedValueOnce([{ count: 12 }]);

      const result = await service.findById('seg-1');

      expect(result.id).toBe('seg-1');
      expect(result.quality_score).toBe(4.0);
      expect(result.geometry).toEqual([
        { lat: 49.1, lng: 16.75 },
        { lat: 49.105, lng: 16.755 },
        { lat: 49.11, lng: 16.76 },
      ]);
      expect(result.elevation_profile).toEqual([350, 380, 420]);
      expect(result.quality_breakdown.excellent).toBe(50);
      expect(result.quality_breakdown.good).toBe(30);
      expect(result.quality_breakdown.fair).toBe(20);
      expect(result.quality_breakdown.poor).toBe(0);
      expect(result.active_hazard_count).toBe(1);
      expect(result.active_hazards).toHaveLength(1);
      expect(result.active_hazards[0]).toMatchObject({
        id: 'h-1',
        hazard_type: 'pothole',
        severity: 'high',
        lat: 49.105,
        lng: 16.755,
        reporter: 'Jane Rider',
        road_name: 'Test Road',
      });
      expect(result.review_count).toBe(4);
      expect(result.avg_review_rating).toBe(4.3);
      expect(result.recent_reviews).toHaveLength(1);
      expect(result.recent_reviews[0]).toMatchObject({
        id: 'r-1',
        user_id: 'user-1',
        user_display_name: 'John Rider',
        rating: 5,
        comment: 'Smooth tarmac',
        bike_model: 'Ducati Monster',
        photos: ['https://media.tarmoto.app/r/abc.jpg'],
      });
      expect(result.riders_per_month).toBe(12);
    });

    it('masks reporter and review author when their profile is private (#279 / #501)', async () => {
      // Codex review on PR #513: the road-detail card embeds
      // `active_hazards` and `recent_reviews` via raw SQL in
      // `roads.service.ts`. Without the privacy_preferences join
      // these queries would still emit `reporter: 'Jane Rider'`
      // and `user_display_name: 'John Rider'` even though the
      // standalone /hazards and /roads/:id/reviews endpoints
      // already mask private riders. The road preview is a
      // public surface, so the same gate must apply here.
      const hazardCreatedAt = new Date('2026-04-14T08:00:00Z');
      const hazardExpiresAt = new Date('2026-04-21T08:00:00Z');
      const reviewCreatedAt = new Date('2026-04-12T15:30:00Z');
      segmentRepo
        .query!.mockResolvedValueOnce([
          {
            id: 'seg-priv',
            road_name: 'Hidden Pass',
            road_number: null,
            quality_score: 4.0,
            curviness_score: 2.5,
            surface_type: 'asphalt',
            length_m: 200,
            confidence: 70,
            reading_count: 7,
            last_updated: new Date('2026-04-13T10:00:00Z'),
            elevation_min: null,
            elevation_max: null,
            elevation_profile: null,
            geojson: { coordinates: [[16.75, 49.1]] },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 1 }])
        // Hazard row: SQL `CASE WHEN profile_visibility = 'private'`
        // already collapsed `reporter` to null and emitted
        // `is_private_reporter = true` so the mapper also nulls
        // `photo_url` (Codex review on PR #513 r3212896110) — the
        // photo filename embeds `<userId>-...` so emitting the URL
        // would still leak the masked id even with the name nulled.
        .mockResolvedValueOnce([
          {
            id: 'h-priv',
            hazard_type: 'pothole',
            severity: 'high',
            note: 'Big crater',
            photo_url:
              'http://localhost:3000/uploads/hazard-photos/user-priv-1700000000000-abc.jpg',
            confirmations: 1,
            created_at: hazardCreatedAt,
            expires_at: hazardExpiresAt,
            lng: 16.755,
            lat: 49.105,
            reporter: null,
            is_private_reporter: true,
            road_name: 'Hidden Pass',
          },
        ])
        .mockResolvedValueOnce([{ count: 1, avg_rating: 5 }])
        // Review row: author is a real user (not deleted) but
        // `is_private_author = true`. Mapper emits the `'Hidden
        // rider'` tombstone, nulls `user_id`, and also nulls
        // `photos` (Codex review on PR #513 r3212896111) — the
        // photo filenames embed `<segmentId>-<userId>-...`.
        .mockResolvedValueOnce([
          {
            id: 'r-priv',
            rating: 5,
            comment: 'Empty road, smooth tarmac',
            bike_model: null,
            photos: [
              'https://media.tarmoto.app/road-review-photos/seg-priv-user-priv-1700000000000-xyz.jpg',
            ],
            created_at: reviewCreatedAt,
            user_id: 'user-priv',
            user_join_id: 'user-priv',
            user_deleted_at: null,
            display_name: 'John Rider',
            is_private_author: true,
          },
        ])
        .mockResolvedValueOnce([{ count: 4 }]);

      const result = await service.findById('seg-priv');

      expect(result.active_hazards).toHaveLength(1);
      expect(result.active_hazards[0].reporter).toBeNull();
      expect(result.active_hazards[0].photo_url).toBeNull();
      expect(result.recent_reviews).toHaveLength(1);
      expect(result.recent_reviews[0].user_id).toBeNull();
      expect(result.recent_reviews[0].user_display_name).toBe('Hidden rider');
      expect(result.recent_reviews[0].photos).toBeNull();
      // The review row itself still surfaces — masking identity,
      // not hiding content.
      expect(result.recent_reviews[0].rating).toBe(5);
      expect(result.recent_reviews[0].comment).toBe(
        'Empty road, smooth tarmac',
      );
    });

    it('keeps the SQL-emitted display name when the author is not private (#279 / #501)', async () => {
      // Defense for the legacy non-private path — `is_private_author`
      // is `false` (or absent) and the mapper surfaces the real
      // display name. Locks in that the new flag doesn't accidentally
      // mask every author.
      segmentRepo
        .query!.mockResolvedValueOnce([
          {
            id: 'seg-public',
            road_name: 'Public Pass',
            road_number: null,
            quality_score: 4.0,
            curviness_score: 2.5,
            surface_type: 'asphalt',
            length_m: 200,
            confidence: 70,
            reading_count: 7,
            last_updated: new Date('2026-04-13T10:00:00Z'),
            elevation_min: null,
            elevation_max: null,
            elevation_profile: null,
            geojson: { coordinates: [[16.75, 49.1]] },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 1, avg_rating: 5 }])
        .mockResolvedValueOnce([
          {
            id: 'r-pub',
            rating: 5,
            comment: 'Smooth',
            bike_model: null,
            photos: null,
            created_at: new Date('2026-04-12T15:30:00Z'),
            user_id: 'user-pub',
            user_join_id: 'user-pub',
            user_deleted_at: null,
            display_name: 'John Rider',
            is_private_author: false,
          },
        ])
        .mockResolvedValueOnce([{ count: 0 }]);

      const result = await service.findById('seg-public');

      expect(result.recent_reviews[0].user_id).toBe('user-pub');
      expect(result.recent_reviews[0].user_display_name).toBe('John Rider');
    });

    it('should throw NotFoundException for missing segment', async () => {
      segmentRepo.query!.mockResolvedValueOnce([]);

      await expect(service.findById('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('road detail queries exclude hidden hazards and reviews', async () => {
      const queries: string[] = [];
      let callCount = 0;
      (segmentRepo.query as jest.Mock).mockImplementation((sql: string) => {
        queries.push(sql);
        callCount++;
        if (callCount === 1) {
          // First call: segment lookup — must return a row to avoid NotFoundException.
          return Promise.resolve([
            {
              id: 'seg-mod',
              road_name: null,
              road_number: null,
              quality_score: null,
              curviness_score: null,
              surface_type: 'asphalt',
              length_m: 100,
              confidence: 0,
              reading_count: 0,
              last_updated: new Date(),
              elevation_min: null,
              elevation_max: null,
              elevation_profile: null,
              geojson: { coordinates: [[16.75, 49.1]] },
            },
          ]);
        }
        return Promise.resolve([]);
      });

      await service.findById('seg-mod');

      // queries[0] = segment lookup (before Promise.all)
      // queries[1] = surface_readings breakdown
      // queries[2] = hazard COUNT (bare column: moderation_status)
      // queries[3] = hazard list (aliased as h: h.moderation_status)
      // queries[4] = review aggregate COUNT/AVG (bare column: moderation_status)
      // queries[5] = recent reviews list (aliased as rr: rr.moderation_status)
      expect(queries[2]).toContain("moderation_status = 'visible'");
      expect(queries[3]).toContain("h.moderation_status = 'visible'");
      expect(queries[4]).toContain('AVG(rating)');
      expect(queries[4]).toContain("moderation_status = 'visible'");
      expect(queries[5]).toContain("rr.moderation_status = 'visible'");
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
            elevation_profile: null,
            geojson: { coordinates: [[16.75, 49.1]] },
          },
        ])
        .mockResolvedValueOnce([]) // no readings
        .mockResolvedValueOnce([{ count: 0 }]) // no hazard count
        .mockResolvedValueOnce([]) // no hazard rows
        .mockResolvedValueOnce([{ count: 0, avg_rating: null }]) // no review stats
        .mockResolvedValueOnce([]) // no review rows
        .mockResolvedValueOnce([{ count: 0 }]); // no riders

      const result = await service.findById('seg-2');

      expect(result.quality_score).toBeNull();
      expect(result.quality_breakdown.excellent).toBe(0);
      expect(result.avg_review_rating).toBeNull();
      expect(result.riders_per_month).toBe(0);
      expect(result.active_hazards).toEqual([]);
      expect(result.active_hazard_count).toBe(0);
      expect(result.recent_reviews).toEqual([]);
      expect(result.elevation_profile).toBeNull();
    });

    it('should sanitize review photos: drop non-https and cap at 5', async () => {
      segmentRepo
        .query!.mockResolvedValueOnce([
          {
            id: 'seg-photos',
            road_name: null,
            road_number: null,
            quality_score: 3.0,
            curviness_score: 2.0,
            surface_type: 'asphalt',
            length_m: 100,
            confidence: 50,
            reading_count: 3,
            last_updated: new Date('2026-04-13T10:00:00Z'),
            elevation_min: null,
            elevation_max: null,
            elevation_profile: null,
            geojson: { coordinates: [[16.75, 49.1]] },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 1, avg_rating: 4.0 }])
        .mockResolvedValueOnce([
          {
            id: 'r-photos',
            rating: 4,
            comment: null,
            bike_model: null,
            photos: [
              'https://media.tarmoto.app/a.jpg',
              'http://insecure.example.com/b.jpg',
              'file:///etc/passwd',
              42,
              null,
              'https://media.tarmoto.app/c.jpg',
              'https://media.tarmoto.app/d.jpg',
              'https://media.tarmoto.app/e.jpg',
              'https://media.tarmoto.app/f.jpg',
              'https://media.tarmoto.app/g.jpg', // 6th valid URL — should be dropped
            ],
            created_at: new Date('2026-04-12T10:00:00Z'),
            user_id: 'user-2',
            user_join_id: 'user-2',
            user_deleted_at: null,
            display_name: 'Safe Rider',
          },
        ])
        .mockResolvedValueOnce([{ count: 0 }]);

      const result = await service.findById('seg-photos');

      expect(result.recent_reviews).toHaveLength(1);
      const photos = result.recent_reviews[0].photos;
      expect(photos).toHaveLength(5);
      expect(photos.every((p) => p.startsWith('https://'))).toBe(true);
      // First valid URL preserved, 6th dropped, insecure scheme removed.
      expect(photos[0]).toBe('https://media.tarmoto.app/a.jpg');
      expect(photos).not.toContain('http://insecure.example.com/b.jpg');
      expect(photos).not.toContain('https://media.tarmoto.app/g.jpg');
    });

    it('should drop an elevation_profile containing a NULL sample', async () => {
      // Postgres array columns can contain NULL elements. `Number(null) === 0`
      // would silently turn a missing sample into a sea-level reading, so the
      // service must treat the whole profile as unusable rather than render
      // a phantom drop to zero.
      segmentRepo
        .query!.mockResolvedValueOnce([
          {
            id: 'seg-null-sample',
            road_name: null,
            road_number: null,
            quality_score: 3.0,
            curviness_score: 2.0,
            surface_type: 'asphalt',
            length_m: 150,
            confidence: 50,
            reading_count: 4,
            last_updated: new Date('2026-04-13T10:00:00Z'),
            elevation_min: 350,
            elevation_max: 420,
            elevation_profile: [350, null, 420],
            geojson: {
              coordinates: [
                [16.7, 49.1],
                [16.71, 49.105],
                [16.72, 49.11],
              ],
            },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0, avg_rating: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      const result = await service.findById('seg-null-sample');

      expect(result.elevation_profile).toBeNull();
    });

    it('should drop a stale elevation_profile that does not match geometry length', async () => {
      segmentRepo
        .query!.mockResolvedValueOnce([
          {
            id: 'seg-3',
            road_name: 'Mismatched',
            road_number: null,
            quality_score: 3.0,
            curviness_score: 2.0,
            surface_type: 'asphalt',
            length_m: 150,
            confidence: 50,
            reading_count: 4,
            last_updated: new Date('2026-04-13T10:00:00Z'),
            elevation_min: 100,
            elevation_max: 150,
            elevation_profile: [100, 150], // length 2, geometry length 3
            geojson: {
              coordinates: [
                [16.7, 49.1],
                [16.71, 49.105],
                [16.72, 49.11],
              ],
            },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0, avg_rating: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      const result = await service.findById('seg-3');

      expect(result.elevation_profile).toBeNull();
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

  describe('findBest', () => {
    it('resolves the region and issues a bbox query with the composite score', async () => {
      (segmentRepo.query as jest.Mock).mockResolvedValueOnce([]);

      await service.findBest({ country: 'cz', region: 'beskydy' });

      expect(segmentRepo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = (segmentRepo.query as jest.Mock).mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('ST_Intersects');
      expect(sql).toContain('ST_MakeEnvelope');
      expect(sql).toContain('best_score');
      // bbox params for Beskydy from the regions catalog
      expect(params.slice(0, 4)).toEqual([18.0, 49.3, 18.85, 49.7]);
      // default limit (last param) = 10
      expect(params[params.length - 1]).toBe(10);
    });

    it('honours a custom limit up to the DTO-validated max', async () => {
      (segmentRepo.query as jest.Mock).mockResolvedValueOnce([]);
      await service.findBest({ country: 'cz', region: 'beskydy', limit: 25 });
      const [, params] = (segmentRepo.query as jest.Mock).mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(params[params.length - 1]).toBe(25);
    });

    it('throws NotFoundException for an unknown region', async () => {
      await expect(
        service.findBest({ country: 'cz', region: 'does-not-exist' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(segmentRepo.query).not.toHaveBeenCalled();
    });

    it('maps SQL rows into BestRoadDto with geometry as {lat,lng}[]', async () => {
      (segmentRepo.query as jest.Mock).mockResolvedValueOnce([
        {
          id: 'seg-1',
          road_name: 'Test Road',
          road_number: null,
          quality_score: 4.5,
          curviness_score: 3.2,
          surface_type: 'asphalt',
          length_m: 5400,
          confidence: 42,
          geojson: {
            type: 'LineString',
            coordinates: [
              [18.4, 49.5],
              [18.41, 49.51],
            ],
          },
          best_score: 12.34,
        },
      ]);

      const result = await service.findBest({
        country: 'cz',
        region: 'beskydy',
      });

      expect(result.region.slug).toBe('beskydy');
      expect(result.region.bbox).toEqual([18.0, 49.3, 18.85, 49.7]);
      expect(result.roads).toHaveLength(1);
      expect(result.roads[0]).toMatchObject({
        id: 'seg-1',
        road_name: 'Test Road',
        quality_score: 4.5,
        surface_type: 'asphalt',
      });
      expect(result.roads[0].geometry).toEqual([
        { lat: 49.5, lng: 18.4 },
        { lat: 49.51, lng: 18.41 },
      ]);
    });

    it('aggregates imported ~100 m segments by way before the length filter (#794)', async () => {
      (segmentRepo.query as jest.Mock).mockResolvedValueOnce([]);
      await service.findBest({ country: 'cz', region: 'beskydy' });

      const [sql] = (segmentRepo.query as jest.Mock).mock.calls[0] as [
        string,
        unknown[],
      ];
      // Group by way (imported) or self (crowd rows, null osm_way_id).
      expect(sql).toContain(
        'GROUP BY COALESCE(rs.osm_way_id::text, rs.id::text)',
      );
      // Length-weighted aggregates + summed length.
      expect(sql).toContain('SUM(rs.length_m)');
      expect(sql).toContain(
        'SUM(rs.quality_score * rs.length_m) / NULLIF(SUM(rs.length_m), 0)',
      );
      expect(sql).toContain('ST_LineMerge(ST_Collect(rs.geom');
      // The length threshold applies to the aggregated road, not a raw segment.
      expect(sql).toMatch(/FROM road\s+WHERE length_m >= \$6/);
    });

    it('flattens a MultiLineString (gappy aggregated way) into one polyline', async () => {
      (segmentRepo.query as jest.Mock).mockResolvedValueOnce([
        {
          id: 'way-1',
          road_name: 'Gappy Way',
          road_number: null,
          quality_score: 4.0,
          curviness_score: 2.0,
          surface_type: 'asphalt',
          length_m: 900,
          confidence: 55,
          geojson: {
            type: 'MultiLineString',
            coordinates: [
              [
                [18.4, 49.5],
                [18.41, 49.51],
              ],
              [
                [18.43, 49.53],
                [18.44, 49.54],
              ],
            ],
          },
          best_score: 10,
        },
      ]);

      const result = await service.findBest({
        country: 'cz',
        region: 'beskydy',
      });

      expect(result.roads[0].geometry).toEqual([
        { lat: 49.5, lng: 18.4 },
        { lat: 49.51, lng: 18.41 },
        { lat: 49.53, lng: 18.43 },
        { lat: 49.54, lng: 18.44 },
      ]);
    });
  });

  describe('findZoneById', () => {
    const boundaryCoords = [
      [18.1, 49.4],
      [18.6, 49.4],
      [18.6, 49.7],
      [18.1, 49.7],
      [18.1, 49.4],
    ];

    it('returns the zone and top roads ordered by contribution_score DESC', async () => {
      (funZoneRepo.query as jest.Mock).mockResolvedValueOnce([
        {
          id: 'fz-1',
          name: 'Beskydy',
          composite_score: 4.5,
          road_count: 25,
          total_curve_km: 120,
          avg_quality: 4.2,
          best_season: 'summer',
          geojson: { coordinates: [boundaryCoords] },
        },
      ]);
      (funZoneRepo.query as jest.Mock).mockResolvedValueOnce([
        {
          id: 'seg-a',
          road_name: 'D56',
          road_number: null,
          quality_score: 4.5,
          curviness_score: 3.2,
          surface_type: 'asphalt',
          length_m: 5400,
          confidence: 80,
          elevation_min: 350,
          elevation_max: 420,
          elevation_profile: [350, 380, 420],
          geojson: {
            coordinates: [
              [18.4, 49.5],
              [18.41, 49.51],
              [18.42, 49.52],
            ],
          },
          contribution_score: 9.9,
        },
        {
          id: 'seg-b',
          road_name: 'D57',
          road_number: null,
          quality_score: 4.0,
          curviness_score: 2.9,
          surface_type: 'asphalt',
          length_m: 3200,
          confidence: 70,
          elevation_min: null,
          elevation_max: null,
          elevation_profile: null,
          geojson: {
            coordinates: [
              [18.45, 49.55],
              [18.46, 49.56],
            ],
          },
          contribution_score: 7.5,
        },
      ]);

      const result = await service.findZoneById('fz-1');

      expect(funZoneRepo.query).toHaveBeenCalledTimes(2);
      const [firstSql, firstParams] = (funZoneRepo.query as jest.Mock).mock
        .calls[0] as [string, unknown[]];
      expect(firstSql).toContain('FROM fun_zones');
      expect(firstSql).toContain('ST_AsGeoJSON');
      expect(firstParams).toEqual(['fz-1']);

      const [secondSql, secondParams] = (funZoneRepo.query as jest.Mock).mock
        .calls[1] as [string, unknown[]];
      expect(secondSql).toContain('FROM fun_zone_roads');
      expect(secondSql).toContain('contribution_score DESC NULLS LAST');
      expect(secondParams[0]).toBe('fz-1');

      expect(result.zone.id).toBe('fz-1');
      expect(result.zone.name).toBe('Beskydy');
      expect(result.zone.composite_score).toBe(4.5);
      expect(result.zone.boundary).toHaveLength(5);
      expect(result.zone.boundary[0]).toEqual({ lat: 49.4, lng: 18.1 });

      expect(result.top_roads).toHaveLength(2);
      expect(result.top_roads[0]).toMatchObject({
        id: 'seg-a',
        contribution_score: 9.9,
        elevation_profile: [350, 380, 420],
      });
      expect(result.top_roads[0].geometry).toEqual([
        { lat: 49.5, lng: 18.4 },
        { lat: 49.51, lng: 18.41 },
        { lat: 49.52, lng: 18.42 },
      ]);
      expect(result.top_roads[1]).toMatchObject({
        id: 'seg-b',
        contribution_score: 7.5,
        elevation_profile: null,
      });
    });

    it('throws NotFoundException when the zone does not exist', async () => {
      (funZoneRepo.query as jest.Mock).mockResolvedValueOnce([]);

      await expect(service.findZoneById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Second query (roads) must not run when the zone isn't found.
      expect(funZoneRepo.query).toHaveBeenCalledTimes(1);
    });

    it('returns top_roads: [] when the zone has no contributing roads', async () => {
      (funZoneRepo.query as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: 'fz-empty',
            name: null,
            composite_score: 3.0,
            road_count: 0,
            total_curve_km: null,
            avg_quality: null,
            best_season: null,
            geojson: { coordinates: [boundaryCoords] },
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.findZoneById('fz-empty');

      expect(result.zone.id).toBe('fz-empty');
      expect(result.zone.name).toBeNull();
      expect(result.top_roads).toEqual([]);
    });

    it('drops a stale elevation_profile that does not match geometry length', async () => {
      (funZoneRepo.query as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: 'fz-3',
            name: 'Mismatch',
            composite_score: 3.2,
            road_count: 1,
            total_curve_km: null,
            avg_quality: null,
            best_season: null,
            geojson: { coordinates: [boundaryCoords] },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'seg-mismatch',
            road_name: null,
            road_number: null,
            quality_score: 3.0,
            curviness_score: 2.0,
            surface_type: 'asphalt',
            length_m: 150,
            confidence: 50,
            elevation_min: 100,
            elevation_max: 150,
            elevation_profile: [100, 150], // geometry has 3 points
            geojson: {
              coordinates: [
                [18.4, 49.5],
                [18.41, 49.51],
                [18.42, 49.52],
              ],
            },
            contribution_score: 1.0,
          },
        ]);

      const result = await service.findZoneById('fz-3');

      expect(result.top_roads[0].elevation_profile).toBeNull();
    });
  });
});
