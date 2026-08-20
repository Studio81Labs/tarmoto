import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RoadsService } from './roads.service.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { MAX_FUN_ZONE_CORRIDOR_RESULTS } from './dto/corridor-fun-zones.dto.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

describe('RoadsService', () => {
  let service: RoadsService;
  let segmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;
  let funZoneRepo: Partial<jest.Mocked<Repository<FunZone>>>;
  let featureResolver: jest.Mocked<Pick<FeatureResolver, 'getGlobalStates'>>;

  beforeEach(async () => {
    segmentRepo = {
      query: jest.fn().mockResolvedValue([]),
    };
    funZoneRepo = {
      query: jest.fn().mockResolvedValue([]),
    };
    // An empty override map resolves every switch ON (`sys_poi_ratings`
    // enabled, `road_quality_overlay` live) so every pre-existing test below
    // is unaffected; the off-case tests set their own state maps.
    featureResolver = {
      getGlobalStates: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoadsService,
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(FunZone), useValue: funZoneRepo },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<RoadsService>(RoadsService);
  });

  describe('findNearby', () => {
    it('should query with correct spatial parameters', async () => {
      await service.findNearby({ lat: 49.1, lng: 16.75 });

      const sql = String(segmentRepo.query!.mock.calls[0]![0]);
      expect(sql).toContain(
        'ST_DWithin(\n          rs.geom,\n          ST_SetSRID(ST_MakePoint($1, $2), 4326)',
      );
      expect(sql).toContain('rs.geom::geography');
      expect(segmentRepo.query).toHaveBeenCalledWith(sql, [16.75, 49.1, 5000]);
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
      expect(results[0]!.id).toBe('seg-1');
      expect(results[0]!.quality_score).toBe(4.2);
      expect(results[0]!.confidence).toBe(80);
      expect(results[0]!.distance_m).toBe(235);
    });

    it('maps quality_source + osm_quality_seed onto the DTO', async () => {
      segmentRepo.query!.mockResolvedValueOnce([
        {
          id: 'seg-1',
          road_name: 'X',
          road_number: null,
          quality_score: 3.6,
          curviness_score: 2,
          surface_type: 'asphalt',
          length_m: 100,
          confidence: 20,
          reading_count: 1,
          last_updated: new Date('2026-04-13T10:00:00Z'),
          distance_m: 12,
          quality_source: 'osm_smoothness',
          osm_quality_seed: 4,
        },
      ]);

      const [dto] = await service.findNearby({ lat: 0, lng: 0 });

      expect(dto!.quality_source).toBe('osm_smoothness');
      expect(dto!.osm_quality_seed).toBe(4);
    });

    it('defaults quality_source and osm_quality_seed to null when the row has no OSM seed', async () => {
      segmentRepo.query!.mockResolvedValueOnce([
        {
          id: 'seg-rider-only',
          road_name: null,
          road_number: null,
          quality_score: null,
          curviness_score: 1.0,
          surface_type: 'unknown',
          length_m: 100,
          confidence: 0,
          reading_count: 0,
          last_updated: new Date('2026-04-13T10:00:00Z'),
          distance_m: 10,
        },
      ]);

      const [dto] = await service.findNearby({ lat: 0, lng: 0 });

      expect(dto!.quality_source).toBeNull();
      expect(dto!.osm_quality_seed).toBeNull();
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

    it('zeroes the embedded review aggregate when sys_poi_ratings is off (and skips the review query)', async () => {
      // #1038-class leak: review aggregates are embedded in the road-detail
      // DTO via a second query path (this service), independent of
      // ReviewsService.listForSegment. Confirms the switch is consulted
      // AND that the review sub-queries themselves are skipped — not just
      // zeroed after the fact.
      featureResolver.getGlobalStates.mockResolvedValue({
        sys_poi_ratings: 'force_off',
      });
      const queries: string[] = [];
      (segmentRepo.query as jest.Mock).mockImplementation((sql: string) => {
        queries.push(sql);
        if (queries.length === 1) {
          // First call: segment lookup — must return a row to avoid NotFoundException.
          return Promise.resolve([
            {
              id: 'seg-off',
              road_name: 'Silent Pass',
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
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.findById('seg-off');

      expect(result.review_count).toBe(0);
      expect(result.avg_review_rating).toBeNull();
      expect(result.recent_reviews).toEqual([]);
      // The rest of the segment DTO is still populated — only the review
      // block is zeroed. `quality_score` surviving also pins the KEY: a
      // `sys_poi_ratings` force_off must not trip the `road_quality_overlay`
      // gate sharing the same `feature_states` read.
      expect(result.id).toBe('seg-off');
      expect(result.road_name).toBe('Silent Pass');
      expect(result.quality_score).toBe(4.0);
      // The review sub-queries are skipped entirely when the switch is off —
      // not merely zeroed after the fact.
      expect(queries.some((q) => q.includes('road_reviews'))).toBe(false);
    });

    it('maps quality_source + osm_quality_seed from the aggregated way query', async () => {
      segmentRepo.query!.mockResolvedValueOnce([
        {
          id: 'seg-osm',
          road_name: 'Test Road',
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
          quality_source: 'osm_surface',
          osm_quality_seed: 3.5,
          geojson: { coordinates: [[16.75, 49.1]] },
        },
      ]);

      const result = await service.findById('seg-osm');

      expect(result.quality_source).toBe('osm_surface');
      expect(result.osm_quality_seed).toBe(3.5);
    });

    it('defaults quality_source and osm_quality_seed to null when the way has no OSM seed', async () => {
      segmentRepo.query!.mockResolvedValueOnce([
        {
          id: 'seg-rider-only',
          road_name: null,
          road_number: null,
          quality_score: 3.0,
          curviness_score: 1.0,
          surface_type: 'asphalt',
          length_m: 100,
          confidence: 10,
          reading_count: 2,
          last_updated: new Date('2026-04-13T10:00:00Z'),
          elevation_min: null,
          elevation_max: null,
          elevation_profile: null,
          geojson: { coordinates: [[16.75, 49.1]] },
        },
      ]);

      const result = await service.findById('seg-rider-only');

      expect(result.quality_source).toBeNull();
      expect(result.osm_quality_seed).toBeNull();
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
      expect(result.active_hazards[0]!.reporter).toBeNull();
      expect(result.active_hazards[0]!.photo_url).toBeNull();
      expect(result.recent_reviews).toHaveLength(1);
      expect(result.recent_reviews[0]!.user_id).toBeNull();
      expect(result.recent_reviews[0]!.user_display_name).toBe('Hidden rider');
      expect(result.recent_reviews[0]!.photos).toBeNull();
      // The review row itself still surfaces — masking identity,
      // not hiding content.
      expect(result.recent_reviews[0]!.rating).toBe(5);
      expect(result.recent_reviews[0]!.comment).toBe(
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

      expect(result.recent_reviews[0]!.user_id).toBe('user-pub');
      expect(result.recent_reviews[0]!.user_display_name).toBe('John Rider');
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
      const photos = result.recent_reviews[0]!.photos;
      expect(photos).toHaveLength(5);
      expect(photos!.every((p) => p.startsWith('https://'))).toBe(true);
      // First valid URL preserved, 6th dropped, insecure scheme removed.
      expect(photos![0]).toBe('https://media.tarmoto.app/a.jpg');
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
        [18.1, 49.4, 18.6, 49.7, 50],
      );
      expect(funZoneRepo.query!.mock.calls[0]?.[0]).toContain('LIMIT $5');
    });

    it('honours a bounded caller limit', async () => {
      await service.findFunZones({
        bbox: '18.1,49.4,18.6,49.7',
        limit: 12,
      });
      expect(funZoneRepo.query).toHaveBeenCalledWith(
        expect.any(String),
        [18.1, 49.4, 18.6, 49.7, 12],
      );
    });

    it.each(['bad', '18.1,49.4,NaN,49.7', '18.6,49.4,18.1,49.7'])(
      'rejects an invalid bbox: %s',
      async (bbox) => {
        await expect(service.findFunZones({ bbox })).rejects.toThrow();
        expect(funZoneRepo.query).not.toHaveBeenCalled();
      },
    );

    it('caps a normal zoomed-out viewport instead of rejecting it', async () => {
      await service.findFunZones({ bbox: '-10,35,40,70' });

      expect(funZoneRepo.query).toHaveBeenCalledWith(
        expect.any(String),
        [-10, 35, 40, 70, 50],
      );
      expect(funZoneRepo.query!.mock.calls[0]?.[0]).toContain('LIMIT $5');
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
      expect(results[0]!.name).toBe('Beskydy');
      expect(results[0]!.composite_score).toBe(4.5);
      expect(results[0]!.boundary).toHaveLength(5);
      expect(results[0]!.boundary[0]).toEqual({ lat: 49.4, lng: 18.1 });
    });
  });

  describe('findFunZonesInCorridor', () => {
    const route = [
      { lat: 49.5, lng: 18.4 },
      { lat: 49.6, lng: 18.6 },
    ];

    it('queries an index-prefiltered + precise geography ST_DWithin over the route line', async () => {
      await service.findFunZonesInCorridor({ route, buffer_km: 3 });

      const [sql, params] = funZoneRepo.query!.mock.calls[0] as [
        string,
        number[],
      ];
      expect(sql).toContain('ST_MakeLine');
      expect(sql).toContain('::geography');
      // Two predicates: the geometry degree-prefilter (index) + the precise
      // geography check (real metres) — same pattern as getRouteQuality.
      expect((sql.match(/ST_DWithin/g) ?? []).length).toBe(2);
      // lng,lat bound positionally per point, then the buffer in metres.
      expect(params).toEqual([18.4, 49.5, 18.6, 49.6, 3000]);
    });

    it('defaults the buffer to 2 km when omitted', async () => {
      await service.findFunZonesInCorridor({ route });
      const [, params] = funZoneRepo.query!.mock.calls[0] as [string, number[]];
      expect(params[params.length - 1]).toBe(2000);
    });

    it('caps the result set so the client projection stays bounded', async () => {
      await service.findFunZonesInCorridor({ route });
      const [sql] = funZoneRepo.query!.mock.calls[0] as [string, number[]];
      expect(sql).toContain(`LIMIT ${MAX_FUN_ZONE_CORRIDOR_RESULTS}`);
    });

    it('maps rows through the shared Fun Zone DTO mapping', async () => {
      funZoneRepo.query!.mockResolvedValueOnce([
        {
          id: 'fz-1',
          name: 'Beskydy switchbacks',
          composite_score: 4.7,
          road_count: 12,
          total_curve_km: 40,
          avg_quality: 4.1,
          best_season: 'summer',
          geojson: {
            coordinates: [
              [
                [18.4, 49.5],
                [18.6, 49.5],
                [18.6, 49.6],
                [18.4, 49.5],
              ],
            ],
          },
        },
      ]);
      const results = await service.findFunZonesInCorridor({ route });
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe('Beskydy switchbacks');
      expect(results[0]!.composite_score).toBe(4.7);
      expect(results[0]!.boundary[0]).toEqual({ lat: 49.5, lng: 18.4 });
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
      expect(result.roads[0]!.geometry).toEqual([
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
      // Length AND confidence thresholds apply to the aggregated road, not raw
      // segments, so a partially-confident way isn't shortened below the length
      // cutoff or dropped when its weighted average still qualifies.
      expect(sql).toMatch(/FROM road\s+[\s\S]*WHERE length_m >= \$6/);
      expect(sql).toContain('AND confidence >= $5');
      // The candidate CTE no longer pre-filters confidence.
      expect(sql).not.toContain('AND rs.confidence >= $5');
    });

    it('returns the longest contiguous part of a gappy MultiLineString (no false connector)', async () => {
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
              // Dense short stub: 3 vertices over a ~30 m span. More points, but
              // geographically tiny — must NOT win.
              [
                [18.4, 49.5],
                [18.4001, 49.5001],
                [18.4002, 49.5002],
              ],
              // Sparse long road: 2 vertices over ~13 km. Fewer points, but the
              // geographically longest part — the one to keep.
              [
                [18.5, 49.6],
                [18.6, 49.7],
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

      // Chosen by geographic length, not vertex count.
      expect(result.roads[0]!.geometry).toEqual([
        { lat: 49.6, lng: 18.5 },
        { lat: 49.7, lng: 18.6 },
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
      expect(result.top_roads[0]!.geometry).toEqual([
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

      expect(result.top_roads[0]!.elevation_profile).toBeNull();
    });
  });

  describe('getRouteQuality', () => {
    const route = [
      { lat: 49.1, lng: 16.7 },
      { lat: 49.2, lng: 16.8 },
    ];

    it('samples the route and nearest-snaps each sample, with flattened positional params and a default 25 m buffer', async () => {
      await service.getRouteQuality({ geometry: route });

      expect(segmentRepo.query).toHaveBeenCalledTimes(1);
      expect(segmentRepo.query).toHaveBeenCalledWith(
        // Walk the route (ST_LineInterpolatePoint), then snap each sample
        // within the buffer (ST_DWithin).
        expect.stringMatching(/ST_LineInterpolatePoint[\s\S]*ST_DWithin/),
        // lng/lat interleaved per point, then the buffer.
        [16.7, 49.1, 16.8, 49.2, 25],
      );
      // Tombstoned rows (deactivated_at set after an OSM split/remove) must
      // not leak stale quality spans into the overlay.
      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('deactivated_at IS NULL'),
        expect.any(Array),
      );
      // Nearest-snap by true metric distance (ST_Distance geography, LIMIT 1)
      // so a crossed cross street doesn't claim a span of the rider's road.
      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringMatching(/ORDER BY ST_Distance[\s\S]*LIMIT 1/),
        expect.any(Array),
      );
      // Repeated passes over the same road become separate spans via the
      // gaps-and-islands ROW_NUMBER grouping, keyed by route-order sample idx.
      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('ROW_NUMBER()'),
        expect.any(Array),
      );
      // A no-coverage route short-circuits before the per-sample lookup runs.
      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('has_any'),
        expect.any(Array),
      );
      // Indexable degree prefilter is paired with a precise metric
      // (`::geography`) check so the snap stays within the real buffer_m.
      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('::geography'),
        expect.any(Array),
      );
    });

    it('rejects a route too long to represent at segment scale (400, no DB round-trip)', async () => {
      await expect(
        service.getRouteQuality({
          geometry: [
            { lat: 49, lng: 0 },
            { lat: 49, lng: 10 }, // ~730 km at this latitude, over the 500 km cap
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(segmentRepo.query).not.toHaveBeenCalled();
    });

    it('honours a custom buffer', async () => {
      await service.getRouteQuality({ geometry: route, buffer_m: 60 });

      expect(segmentRepo.query).toHaveBeenCalledWith(
        expect.any(String),
        [16.7, 49.1, 16.8, 49.2, 60],
      );
    });

    it('maps rows to spans, coercing pg string numerics and keeping null quality', async () => {
      (segmentRepo.query as jest.Mock).mockResolvedValueOnce([
        {
          segment_id: 'seg-uuid-1',
          osm_way_id: '123',
          segment_index: 0,
          quality_score: '4.2',
          curviness_score: '3.1',
          surface_type: 'asphalt',
          reading_count: '12',
          start_fraction: '0',
          end_fraction: '0.4',
        },
        {
          segment_id: null,
          osm_way_id: null,
          segment_index: null,
          quality_score: null,
          curviness_score: '0',
          surface_type: 'unknown',
          reading_count: '0',
          start_fraction: '0.4',
          end_fraction: '1',
        },
      ]);

      const result = await service.getRouteQuality({ geometry: route });

      expect(result.segments).toEqual([
        {
          segment_id: 'seg-uuid-1',
          osm_way_id: '123',
          segment_index: 0,
          quality_score: 4.2,
          curviness_score: 3.1,
          surface_type: 'asphalt',
          reading_count: 12,
          start_fraction: 0,
          end_fraction: 0.4,
        },
        {
          segment_id: null,
          osm_way_id: null,
          segment_index: null,
          quality_score: null,
          curviness_score: 0,
          surface_type: 'unknown',
          reading_count: 0,
          start_fraction: 0.4,
          end_fraction: 1,
        },
      ]);
    });

    it('returns an empty list (never throws) but logs the failure without route coordinates when the spatial query fails', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      (segmentRepo.query as jest.Mock).mockRejectedValueOnce(
        new Error('pg unavailable'),
      );

      await expect(
        service.getRouteQuality({ geometry: route }),
      ).resolves.toEqual({ segments: [] });

      // The failure is surfaced to logs (a real outage must not look like a
      // no-coverage route) — but the route coordinates never are.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('route-quality query failed'),
      );
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join(' ');
      expect(logged).not.toContain('16.7');
      expect(logged).not.toContain('49.1');
      errorSpy.mockRestore();
    });
  });

  describe('road_quality_overlay operator kill (#1203)', () => {
    // The kill is keyed to `road_quality_overlay` SPECIFICALLY. Every
    // force_off below sets ONLY that key, so a gate reading any other flag
    // would resolve "live" and fail the null assertions; the wrong-key /
    // force_on cases prove the reverse direction (nothing else trips it).
    const killed = () => {
      featureResolver.getGlobalStates.mockResolvedValue({
        road_quality_overlay: 'force_off',
      });
    };

    const funZoneRow = {
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
    };

    it('findFunZones: nulls avg_quality but keeps the zone (discovery survives)', async () => {
      killed();
      funZoneRepo.query!.mockResolvedValueOnce([funZoneRow]);

      const [zone] = await service.findFunZones({
        bbox: '18.1,49.4,18.6,49.7',
      });

      expect(zone!.avg_quality).toBeNull();
      // The zone itself is NOT the killed data.
      expect(zone).toMatchObject({
        id: 'fz-1',
        name: 'Beskydy',
        composite_score: 4.5,
        road_count: 25,
        total_curve_km: 120,
        best_season: 'summer',
      });
      expect(zone!.boundary).toHaveLength(5);
    });

    it('findFunZones: a force_off on a DIFFERENT key does not trip the gate', async () => {
      featureResolver.getGlobalStates.mockResolvedValue({
        hazard_alerts: 'force_off',
      });
      funZoneRepo.query!.mockResolvedValueOnce([funZoneRow]);

      const [zone] = await service.findFunZones({
        bbox: '18.1,49.4,18.6,49.7',
      });

      expect(zone!.avg_quality).toBe(4.2);
    });

    it('findFunZones: force_on resolves live (only force_off kills)', async () => {
      featureResolver.getGlobalStates.mockResolvedValue({
        road_quality_overlay: 'force_on',
      });
      funZoneRepo.query!.mockResolvedValueOnce([funZoneRow]);

      const [zone] = await service.findFunZones({
        bbox: '18.1,49.4,18.6,49.7',
      });

      expect(zone!.avg_quality).toBe(4.2);
    });

    it('findFunZonesInCorridor: nulls avg_quality through the shared mapper', async () => {
      killed();
      funZoneRepo.query!.mockResolvedValueOnce([funZoneRow]);

      const [zone] = await service.findFunZonesInCorridor({
        route: [
          { lat: 49.5, lng: 18.4 },
          { lat: 49.6, lng: 18.6 },
        ],
      });

      expect(zone!.avg_quality).toBeNull();
      expect(zone!.composite_score).toBe(4.5);
    });

    it('findZoneById: nulls zone avg_quality + per-road quality_score AND contribution_score, keeps the roads', async () => {
      killed();
      (funZoneRepo.query as jest.Mock)
        .mockResolvedValueOnce([funZoneRow])
        .mockResolvedValueOnce([
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
        ]);

      const result = await service.findZoneById('fz-1');

      expect(result.zone.avg_quality).toBeNull();
      expect(result.zone.composite_score).toBe(4.5);
      expect(result.top_roads).toHaveLength(1);
      expect(result.top_roads[0]!.quality_score).toBeNull();
      // contribution_score is curviness·quality·length (normalized,
      // multiplicative) with curviness + length served in the same row — one
      // division recovers the killed score, so it nulls WITH it.
      expect(result.top_roads[0]!.contribution_score).toBeNull();
      // The road itself still serves.
      expect(result.top_roads[0]).toMatchObject({
        id: 'seg-a',
        road_name: 'D56',
        curviness_score: 3.2,
        surface_type: 'asphalt',
        length_m: 5400,
      });
      expect(result.top_roads[0]!.geometry).toHaveLength(3);
    });

    it('findBest: nulls quality_score AND the algebraically invertible best_score, keeps the road', async () => {
      killed();
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

      expect(result.roads).toHaveLength(1);
      expect(result.roads[0]!.quality_score).toBeNull();
      // best_score = quality*2 + curviness + LEAST(length_km,20)*0.1 and
      // curviness + length_m are in the same row: serving it would hand the
      // killed quality back in one line of algebra.
      expect(result.roads[0]!.best_score).toBeNull();
      expect(result.roads[0]).toMatchObject({
        id: 'seg-1',
        road_name: 'Test Road',
        curviness_score: 3.2,
        surface_type: 'asphalt',
        length_m: 5400,
        confidence: 42,
      });
    });

    it('findBest: a force_off on a DIFFERENT key leaves both scores served', async () => {
      featureResolver.getGlobalStates.mockResolvedValue({
        sys_poi_ratings: 'force_off',
      });
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

      expect(result.roads[0]!.quality_score).toBe(4.5);
      expect(result.roads[0]!.best_score).toBe(12.34);
    });

    it('findNearby: nulls the quality readouts and neutralizes the min_quality oracle', async () => {
      killed();
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
          quality_source: 'osm_smoothness',
          osm_quality_seed: 4,
          last_updated: new Date('2026-04-13T10:00:00Z'),
          distance_m: 234.56,
        },
      ]);

      const [dto] = await service.findNearby({
        lat: 49.1,
        lng: 16.75,
        min_quality: 3.5,
        surface_type: 'asphalt',
      });

      // Readouts null; the segment (curviness, surface, distance) survives.
      expect(dto!.quality_score).toBeNull();
      expect(dto!.quality_source).toBeNull();
      expect(dto!.osm_quality_seed).toBeNull();
      expect(dto!.curviness_score).toBe(3.5);
      expect(dto!.surface_type).toBe('asphalt');
      expect(dto!.distance_m).toBe(235);

      // With the readouts nulled but the filter still applied, bisecting
      // min_quality would recover each road's killed score — so the
      // predicate must not reach the SQL at all. The surface filter (not
      // quality data) still applies, taking the freed $4 slot.
      const [sql, params] = segmentRepo.query!.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).not.toContain('quality_score >=');
      expect(params).toEqual([16.75, 49.1, 5000, 'asphalt']);
      expect(sql).toContain('surface_type = $4');
    });

    it('findById: nulls quality readouts, skips the reading-derived quality queries, keeps hazards + reviews', async () => {
      killed();
      const queries: string[] = [];
      (segmentRepo.query as jest.Mock).mockImplementation((sql: string) => {
        queries.push(sql);
        if (queries.length === 1) {
          return Promise.resolve([
            {
              id: 'seg-1',
              road_name: 'Test Road',
              road_number: null,
              quality_score: 4.0,
              curviness_score: 2.5,
              surface_type: 'asphalt',
              quality_source: 'osm_smoothness',
              osm_quality_seed: 4,
              length_m: 200,
              confidence: 70,
              reading_count: 7,
              last_updated: new Date('2026-04-13T10:00:00Z'),
              elevation_min: 350,
              elevation_max: 420,
              elevation_profile: null,
              geojson: { coordinates: [[16.75, 49.1]] },
            },
          ]);
        }
        if (
          sql.includes('COUNT(*)::int AS count') &&
          sql.includes('hazard_reports')
        ) {
          return Promise.resolve([{ count: 2 }]);
        }
        if (sql.includes('avg_rating')) {
          return Promise.resolve([{ count: 4, avg_rating: 4.3 }]);
        }
        return Promise.resolve([]);
      });

      const result = await service.findById('seg-1');

      // Quality readouts null…
      expect(result.quality_score).toBeNull();
      expect(result.quality_source).toBeNull();
      expect(result.osm_quality_seed).toBeNull();
      // …and the reading-derived quality blocks are the neutral no-readings
      // shape, produced WITHOUT running their queries.
      expect(result.quality_breakdown).toEqual({
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0,
        very_poor: 0,
      });
      expect(result.quality_history).toEqual([]);
      expect(result.regional_quality_history).toEqual([]);
      expect(queries.some((q) => q.includes('GROUP BY classification'))).toBe(
        false,
      );
      expect(queries.some((q) => q.includes("INTERVAL '24 months'"))).toBe(
        false,
      );
      // The road and its community blocks are NOT the killed data:
      // sys_poi_ratings is untouched, so the review aggregate still serves.
      expect(result.curviness_score).toBe(2.5);
      expect(result.surface_type).toBe('asphalt');
      expect(result.active_hazard_count).toBe(2);
      expect(result.review_count).toBe(4);
      expect(result.avg_review_rating).toBe(4.3);
      expect(queries.some((q) => q.includes('road_reviews'))).toBe(true);
    });

    it('getSegmentTrend: returns the no-readings shape without querying (the trend IS quality data)', async () => {
      killed();

      const result = await service.getSegmentTrend('seg-1');

      expect(result).toEqual({ segment_id: 'seg-1', points: [] });
      expect(segmentRepo.query).not.toHaveBeenCalled();
    });

    it('getRouteQuality: keeps the spans (surface/curviness) but nulls quality_score per span', async () => {
      killed();
      (segmentRepo.query as jest.Mock).mockResolvedValueOnce([
        {
          segment_id: 'seg-uuid-1',
          osm_way_id: '123',
          segment_index: 0,
          quality_score: '4.2',
          curviness_score: '3.1',
          surface_type: 'asphalt',
          reading_count: '12',
          start_fraction: '0',
          end_fraction: '0.4',
        },
      ]);

      const result = await service.getRouteQuality({
        geometry: [
          { lat: 49.1, lng: 16.7 },
          { lat: 49.2, lng: 16.8 },
        ],
      });

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]).toEqual({
        segment_id: 'seg-uuid-1',
        osm_way_id: '123',
        segment_index: 0,
        quality_score: null,
        curviness_score: 3.1,
        surface_type: 'asphalt',
        reading_count: 12,
        start_fraction: 0,
        end_fraction: 0.4,
      });
    });
  });
});
