import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_PRIVACY_PREFERENCES } from '@tarmoto/shared';
import { ExplorationService } from './exploration.service.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

describe('ExplorationService', () => {
  let service: ExplorationService;
  let rideSegmentRepo: Partial<jest.Mocked<Repository<RideSegment>>>;
  let roadSegmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;
  let privacy: { loadPreferences: jest.Mock };
  let featureResolver: { isSystemSwitchEnabled: jest.Mock };

  const mockRideSegmentQb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    subQuery: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    // `distinctOn` is consumed inside the `from(qb => qb.subQuery()...)`
    // callback of `getRiddenSegments`. The mock's `from()` is a
    // `mockReturnThis` that never invokes the callback, so the test
    // suite happens to pass without this stub — but mirroring the
    // real surface keeps the mock honest if a future test ever
    // exercises the subquery body directly.
    distinctOn: jest.fn().mockReturnThis(),
    getQuery: jest.fn().mockReturnValue(''),
    getRawOne: jest.fn().mockResolvedValue({ count: '15' }),
    getRawMany: jest.fn().mockResolvedValue([{ id: 'seg-1' }, { id: 'seg-2' }]),
  };

  const mockRoadSegmentQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([
      {
        id: 'seg-10',
        road_name: 'Mountain Pass Road',
        length_m: 2500,
        quality_score: 4.2,
        surface_type: 'asphalt',
        distance_m: 1234.56,
      },
    ]),
  };

  const mockRideQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ total: '350.5' }),
  };

  beforeEach(async () => {
    rideSegmentRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockRideSegmentQb),
      // `getRiddenSegments` builds its outer query via
      // `manager.createQueryBuilder()` so the FROM clause is a subquery
      // (not the `RideSegment` repo's auto-aliased table). Mirror that
      // shape in the mock so the test mirrors the runtime call graph.
      manager: {
        createQueryBuilder: jest.fn().mockReturnValue(mockRideSegmentQb),
      },
    } as Partial<jest.Mocked<Repository<RideSegment>>>;
    roadSegmentRepo = {
      count: jest.fn().mockResolvedValue(100),
      createQueryBuilder: jest.fn().mockReturnValue(mockRoadSegmentQb),
    };
    rideRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockRideQb),
    };

    privacy = {
      // Default: consent on so existing assertions about
      // `getNearbyUnridden` returning rows keep passing. Specific tests
      // override with `personalized_recommendations_consent: false`.
      loadPreferences: jest.fn().mockResolvedValue({
        ...DEFAULT_PRIVACY_PREFERENCES,
      }),
    };

    // Default: switch ON so every pre-existing test below is unaffected;
    // the off-case tests override with `mockResolvedValue(false)`.
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExplorationService,
        { provide: getRepositoryToken(RideSegment), useValue: rideSegmentRepo },
        { provide: getRepositoryToken(RoadSegment), useValue: roadSegmentRepo },
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: PrivacyPreferencesService, useValue: privacy },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<ExplorationService>(ExplorationService);
    jest.clearAllMocks();
  });

  describe('getStats', () => {
    it('should return exploration stats', async () => {
      mockRideSegmentQb.getRawOne.mockResolvedValueOnce({ count: '15' });
      roadSegmentRepo.count!.mockResolvedValueOnce(100);
      mockRideQb.getRawOne.mockResolvedValueOnce({ total: '350.5' });

      const result = await service.getStats('user-1');

      expect(result.ridden_segments).toBe(15);
      expect(result.total_segments).toBe(100);
      expect(result.percent_explored).toBe(15);
      expect(result.total_distance_km).toBe(350.5);
    });

    it('should return 0 percent when no segments exist', async () => {
      mockRideSegmentQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      roadSegmentRepo.count!.mockResolvedValueOnce(0);
      mockRideQb.getRawOne.mockResolvedValueOnce({ total: '0' });

      const result = await service.getStats('user-1');

      expect(result.percent_explored).toBe(0);
      expect(result.ridden_segments).toBe(0);
    });

    it('should handle null results gracefully', async () => {
      mockRideSegmentQb.getRawOne.mockResolvedValueOnce(null);
      roadSegmentRepo.count!.mockResolvedValueOnce(50);
      mockRideQb.getRawOne.mockResolvedValueOnce(null);

      const result = await service.getStats('user-1');

      expect(result.ridden_segments).toBe(0);
      expect(result.total_distance_km).toBe(0);
    });

    it('should filter by completed rides only', async () => {
      mockRideSegmentQb.getRawOne.mockResolvedValueOnce({ count: '10' });
      roadSegmentRepo.count!.mockResolvedValueOnce(100);
      mockRideQb.getRawOne.mockResolvedValueOnce({ total: '100' });

      await service.getStats('user-1');

      expect(mockRideSegmentQb.andWhere).toHaveBeenCalledWith(
        "r.status = 'completed'",
      );
    });

    it('getStats returns zeroed stats without querying when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.getStats('user-1');
      expect(result).toEqual({
        ridden_segments: 0,
        total_segments: 0,
        percent_explored: 0,
        total_distance_km: 0,
      });
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
      expect(roadSegmentRepo.count).not.toHaveBeenCalled();
    });
  });

  describe('getNearbyUnridden', () => {
    it('should return nearby unridden segments sorted by distance', async () => {
      const result = await service.getNearbyUnridden(
        'user-1',
        49.2,
        16.6,
        10,
        20,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('seg-10');
      expect(result[0].road_name).toBe('Mountain Pass Road');
      expect(result[0].distance_m).toBe(1235);
    });

    it('should use correct radius in meters', async () => {
      await service.getNearbyUnridden('user-1', 49.2, 16.6, 25, 10);

      expect(mockRoadSegmentQb.where).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        { lng: 16.6, lat: 49.2, radius: 25000 },
      );
    });

    it('should exclude user ridden segments', async () => {
      await service.getNearbyUnridden('user-1', 49.2, 16.6, 10, 20);

      expect(mockRoadSegmentQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('NOT IN'),
        { userId: 'user-1' },
      );
    });

    it('should return empty array when all nearby segments are ridden', async () => {
      mockRoadSegmentQb.getRawMany.mockResolvedValueOnce([]);

      const result = await service.getNearbyUnridden(
        'user-1',
        49.2,
        16.6,
        10,
        20,
      );

      expect(result).toHaveLength(0);
    });

    it('returns empty without querying when personalized recommendations consent is off (#279 / #501)', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        personalized_recommendations_consent: false,
      });
      // Sanity baseline — the segment fixture WOULD have produced a row
      // if the gate let the query through.
      mockRoadSegmentQb.getRawMany.mockClear();

      const result = await service.getNearbyUnridden(
        'user-1',
        49.2,
        16.6,
        10,
        20,
      );

      expect(result).toEqual([]);
      // We must NOT have run the personalised SQL — bailing before the
      // query is the whole point of the consent gate.
      expect(mockRoadSegmentQb.getRawMany).not.toHaveBeenCalled();
    });

    it('runs the personalised query when consent is on (#279 / #501)', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        personalized_recommendations_consent: true,
      });

      const result = await service.getNearbyUnridden(
        'user-1',
        49.2,
        16.6,
        10,
        20,
      );

      expect(result).toHaveLength(1);
      expect(mockRoadSegmentQb.getRawMany).toHaveBeenCalled();
    });

    it('getNearbyUnridden returns [] when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.getNearbyUnridden(
        'user-1',
        49.1,
        16.7,
        10,
        20,
      );
      expect(result).toEqual([]);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
      // The switch gate is the FIRST statement — it must short-circuit
      // before the privacy-consent lookup, not just before the query.
      expect(privacy.loadPreferences).not.toHaveBeenCalled();
    });
  });

  describe('getRiddenIds', () => {
    it('should return distinct ridden segment IDs', async () => {
      mockRideSegmentQb.getRawMany.mockResolvedValueOnce([
        { id: 'seg-1' },
        { id: 'seg-2' },
        { id: 'seg-3' },
      ]);

      const result = await service.getRiddenIds('user-1');

      expect(result.segment_ids).toEqual(['seg-1', 'seg-2', 'seg-3']);
    });

    it('should return empty array when no segments ridden', async () => {
      mockRideSegmentQb.getRawMany.mockResolvedValueOnce([]);

      const result = await service.getRiddenIds('user-1');

      expect(result.segment_ids).toEqual([]);
    });

    it('should filter by completed rides', async () => {
      mockRideSegmentQb.getRawMany.mockResolvedValueOnce([]);

      await service.getRiddenIds('user-1');

      expect(mockRideSegmentQb.andWhere).toHaveBeenCalledWith(
        "r.status = 'completed'",
      );
    });

    it('getRiddenIds returns empty when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.getRiddenIds('user-1');
      expect(result).toEqual({ segment_ids: [] });
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
      expect(mockRideSegmentQb.getRawMany).not.toHaveBeenCalled();
    });
  });

  describe('getRiddenSegments', () => {
    it('normalises timestamps and ride_count for the road-map layer (US-50)', async () => {
      const lastRidden = new Date('2026-04-01T08:30:00.000Z');
      mockRideSegmentQb.getRawMany.mockResolvedValueOnce([
        {
          id: 'seg-1',
          last_ridden_at: lastRidden,
          last_quality_score: 4.2,
          ride_count: '3',
        },
        {
          id: 'seg-2',
          last_ridden_at: '2025-11-12T10:00:00.000Z',
          last_quality_score: null,
          ride_count: 1,
        },
      ]);

      const result = await service.getRiddenSegments('user-1');

      expect(result.segments).toEqual([
        {
          id: 'seg-1',
          last_ridden_at: lastRidden.toISOString(),
          last_quality_score: 4.2,
          ride_count: 3,
        },
        {
          id: 'seg-2',
          last_ridden_at: '2025-11-12T10:00:00.000Z',
          last_quality_score: null,
          ride_count: 1,
        },
      ]);
    });

    it('returns an empty list when the user has no completed rides', async () => {
      mockRideSegmentQb.getRawMany.mockResolvedValueOnce([]);

      const result = await service.getRiddenSegments('user-1');

      expect(result.segments).toEqual([]);
    });

    it('getRiddenSegments returns empty when sys_gamification is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      const result = await service.getRiddenSegments('user-1');
      expect(result).toEqual({ segments: [] });
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_gamification',
      );
      expect(
        rideSegmentRepo.manager!.createQueryBuilder,
      ).not.toHaveBeenCalled();
    });
  });
});
