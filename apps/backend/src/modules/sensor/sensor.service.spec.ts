/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_PRIVACY_PREFERENCES } from '@tarmoto/shared';
import { SensorService } from './sensor.service.js';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { SensorReadingDto } from './dto/upload-sensor-data.dto.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';

describe('SensorService', () => {
  let service: SensorService;
  let readingRepo: Partial<jest.Mocked<Repository<SurfaceReading>>>;
  let segmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;
  let statsRepo: Partial<jest.Mocked<Repository<RideStats>>>;
  let storedStats: Partial<RideStats> | null;
  let privacy: { loadPreferences: jest.Mock };

  beforeEach(async () => {
    readingRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    segmentRepo = {
      query: jest.fn().mockResolvedValue([{ id: 'segment-1' }]),
    };

    storedStats = null;
    // Mock `query()` to simulate the atomic INSERT ... ON CONFLICT DO
    // UPDATE the production code now uses (see `upsertLeanStats` for
    // why the merge moved into SQL). Tracks the latest row so tests
    // can assert against `storedStats` without parsing the SQL — the
    // semantics being mocked are: max via GREATEST, distribution via
    // per-bucket integer addition.
    statsRepo = {
      query: jest.fn().mockImplementation((_sql, params: unknown[]) => {
        const [rideId, batchMax, distJson] = params as [string, number, string];
        const batchDist = JSON.parse(distJson) as Record<string, number>;
        if (storedStats === null) {
          storedStats = {
            ride_id: rideId,
            max_lean_angle: batchMax,
            lean_distribution_json: {
              '0_10': batchDist['0_10'] ?? 0,
              '10_20': batchDist['10_20'] ?? 0,
              '20_30': batchDist['20_30'] ?? 0,
              '30_plus': batchDist['30_plus'] ?? 0,
            },
          };
        } else {
          const existingDist =
            (storedStats.lean_distribution_json as Record<string, number>) ??
            {};
          storedStats.max_lean_angle = Math.max(
            storedStats.max_lean_angle ?? 0,
            batchMax,
          );
          storedStats.lean_distribution_json = {
            '0_10': (existingDist['0_10'] ?? 0) + (batchDist['0_10'] ?? 0),
            '10_20': (existingDist['10_20'] ?? 0) + (batchDist['10_20'] ?? 0),
            '20_30': (existingDist['20_30'] ?? 0) + (batchDist['20_30'] ?? 0),
            '30_plus':
              (existingDist['30_plus'] ?? 0) + (batchDist['30_plus'] ?? 0),
          };
        }
        return Promise.resolve([]);
      }),
    };

    privacy = {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_PRIVACY_PREFERENCES }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorService,
        { provide: getRepositoryToken(SurfaceReading), useValue: readingRepo },
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(RideStats), useValue: statsRepo },
        { provide: PrivacyPreferencesService, useValue: privacy },
      ],
    }).compile();

    service = module.get<SensorService>(SensorService);
  });

  describe('processSegment', () => {
    it('should classify smooth road as excellent', () => {
      // Simulate readings where acceleration magnitude ≈ 9.81 (still phone)
      const readings: SensorReadingDto[] = Array.from(
        { length: 50 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8, // mag ≈ 9.8, deviation ≈ 0.01
          lat: 49.1,
          lng: 16.75,
          speed: 15,
        }),
      );

      const result = service.processSegment(readings);

      expect(result).not.toBeNull();
      expect(result!.classification).toBe('excellent');
      expect(result!.rms).toBeLessThan(1.5);
    });

    it('should classify rough road as poor', () => {
      // Simulate high-vibration readings
      const readings: SensorReadingDto[] = Array.from(
        { length: 50 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: 3.0 * Math.sin(i),
          ay: 2.0 * Math.cos(i),
          az: 9.81 + 5.0 * Math.sin(i * 2),
          lat: 49.1,
          lng: 16.75,
          speed: 15,
        }),
      );

      const result = service.processSegment(readings);

      expect(result).not.toBeNull();
      expect(result!.rms).toBeGreaterThan(3.0);
      expect(['fair', 'poor', 'very_poor']).toContain(result!.classification);
    });

    it('should return null for empty readings', () => {
      const result = service.processSegment([]);
      expect(result).toBeNull();
    });

    it('should return null for readings without GPS', () => {
      const readings: SensorReadingDto[] = Array.from(
        { length: 50 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
        }),
      );

      const result = service.processSegment(readings);
      expect(result).toBeNull();
    });

    it('should calculate average speed in m/s', () => {
      const readings: SensorReadingDto[] = Array.from(
        { length: 20 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1,
          lng: 16.75,
          speed: 10 + i, // 10-29 m/s
        }),
      );

      const result = service.processSegment(readings);

      expect(result).not.toBeNull();
      expect(result!.speedAvg).toBeCloseTo(19.5, 0);
    });

    it('should infer gravel surface from high-frequency rough vibration', () => {
      const readings: SensorReadingDto[] = Array.from(
        { length: 50 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: i % 2 === 0 ? 4.5 : -4.5,
          ay: 0.2,
          az: 9.81 + (i % 2 === 0 ? 3.8 : -3.8),
          lat: 49.1,
          lng: 16.75,
          speed: 15,
        }),
      );

      const result = service.processSegment(readings);

      expect(result).not.toBeNull();
      expect(result!.surfaceType).toBe('gravel');
    });

    it('should leave surface type inconclusive for smooth low-signal vibration', () => {
      const readings: SensorReadingDto[] = Array.from(
        { length: 50 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1,
          lng: 16.75,
          speed: 15,
        }),
      );

      const result = service.processSegment(readings);

      expect(result).not.toBeNull();
      expect(result!.surfaceType).toBeNull();
    });

    it('should ignore isolated spikes when surface vibration is otherwise low', () => {
      const readings: SensorReadingDto[] = Array.from(
        { length: 50 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: i === 25 ? 20 : 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1,
          lng: 16.75,
          speed: 15,
        }),
      );

      const result = service.processSegment(readings);

      expect(result).not.toBeNull();
      expect(result!.surfaceType).toBeNull();
    });
  });

  describe('groupIntoSegments', () => {
    it('should group readings by ~100m GPS distance', () => {
      // Create readings along a straight line ~250m long
      // Each step: ~0.001 degree latitude ≈ 111m
      const readings: SensorReadingDto[] = [];
      for (let i = 0; i < 100; i++) {
        readings.push({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.0003, // ~33m per step
          lng: 16.75,
          speed: 15,
        });
      }

      const segments = service.groupIntoSegments(readings);

      // ~3300m total / 100m segments ≈ 3+ segments
      expect(segments.length).toBeGreaterThanOrEqual(2);
      segments.forEach((seg) => {
        expect(seg.sampleCount).toBeGreaterThan(0);
        expect(seg.lat).toBeDefined();
        expect(seg.lng).toBeDefined();
      });
    });

    it('should handle single-segment short ride', () => {
      const readings: SensorReadingDto[] = Array.from(
        { length: 20 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.00001,
          lng: 16.75,
          speed: 5,
        }),
      );

      const segments = service.groupIntoSegments(readings);

      expect(segments.length).toBe(1);
    });
  });

  describe('processUpload', () => {
    it('should process readings and create surface_reading records', async () => {
      const dto = {
        ride_id: 'ride-1',
        device_model: 'iPhone 15',
        client_model_version: 'rsc-v1.0.0',
        readings: Array.from({ length: 50 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.00001,
          lng: 16.75,
          speed: 15,
        })),
      };

      const result = await service.processUpload('user-1', dto);

      expect(result.accepted).toBe(50);
      expect(result.segments_updated).toBeGreaterThanOrEqual(1);
      expect(readingRepo.create).toHaveBeenCalled();
      expect(readingRepo.save).toHaveBeenCalled();

      // Verify the created reading has correct fields
      const createArg = (readingRepo.create as jest.Mock).mock.calls[0][0];
      expect(createArg.road_segment_id).toBe('segment-1');
      expect(createArg.ride_id).toBe('ride-1');
      expect(createArg.user_id).toBe('user-1');
      expect(createArg.device_model).toBe('iPhone 15');
      expect(createArg.classification).toBe('excellent');
      // US-3: client classifier identifier propagates onto every
      // persisted row as telemetry — the row's `classification` /
      // `surface_type` are still server-derived above.
      expect(createArg.client_model_version).toBe('rsc-v1.0.0');
    });

    it('persists client_model_version=null when the heuristic fallback ran on the client', async () => {
      const dto = {
        ride_id: 'ride-1',
        device_model: 'iPhone 15',
        // client_model_version intentionally omitted — mobile sets it
        // to null (and serialises as undefined) when the v0 RMS
        // heuristic produced the window-level outputs.
        readings: Array.from({ length: 50 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.00001,
          lng: 16.75,
          speed: 15,
        })),
      };

      await service.processUpload('user-1', dto);

      const createArg = (readingRepo.create as jest.Mock).mock.calls[0][0];
      expect(createArg.client_model_version).toBeNull();
    });

    it('should return zero when all readings lack GPS', async () => {
      const dto = {
        ride_id: 'ride-1',
        readings: Array.from({ length: 10 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
        })),
      };

      const result = await service.processUpload('user-1', dto);

      expect(result.accepted).toBe(0);
      expect(result.segments_updated).toBe(0);
    });

    it('should filter out stopped readings (speed < 10 km/h)', async () => {
      const dto = {
        ride_id: 'ride-1',
        readings: Array.from({ length: 30 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1,
          lng: 16.75,
          speed: 1.0, // ~3.6 km/h — should be filtered
        })),
      };

      const result = await service.processUpload('user-1', dto);

      expect(result.accepted).toBe(0);
    });

    it('skips persisting surface_readings when road_data_contribution is off (#279)', async () => {
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        road_data_contribution: false,
      });

      const dto = {
        ride_id: 'ride-1',
        readings: Array.from({ length: 50 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.00001,
          lng: 16.75,
          speed: 15,
          // Lean stats are personal-history; verifying the upsertLeanStats
          // path still runs (statsRepo.query) is below.
          lean_deg: 12,
        })),
      };

      const result = await service.processUpload('user-1', dto);

      expect(result.accepted).toBe(0);
      expect(result.segments_updated).toBe(0);
      // No surface readings persisted, no road-segment lookup either.
      expect(readingRepo.save).not.toHaveBeenCalled();
      expect(segmentRepo.query).not.toHaveBeenCalled();
      // Personal lean stats still recorded — it's the rider's own
      // history, not aggregated into the public road map.
      expect(statsRepo.query).toHaveBeenCalled();
    });

    it('should handle no matching road segment gracefully', async () => {
      segmentRepo.query!.mockResolvedValue([]); // No road segments found

      const dto = {
        ride_id: 'ride-1',
        readings: Array.from({ length: 20 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.00001,
          lng: 16.75,
          speed: 15,
        })),
      };

      const result = await service.processUpload('user-1', dto);

      expect(result.accepted).toBe(20);
      expect(result.segments_updated).toBe(0);
      expect(readingRepo.save).not.toHaveBeenCalled();
    });

    it('should accept readings without speed field', async () => {
      const dto = {
        ride_id: 'ride-1',
        readings: Array.from({ length: 20 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.00001,
          lng: 16.75,
          // no speed field — should be accepted
        })),
      };

      const result = await service.processUpload('user-1', dto);

      expect(result.accepted).toBe(20);
      expect(result.segments_updated).toBeGreaterThanOrEqual(1);

      // speed_at_reading should be null, not 0
      const createArg = (readingRepo.create as jest.Mock).mock.calls[0][0];
      expect(createArg.speed_at_reading).toBeNull();
    });

    it('does not duplicate road quality aggregation owned by the database trigger', async () => {
      const dto = {
        ride_id: 'ride-1',
        readings: Array.from({ length: 20 }, (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1 + i * 0.00001,
          lng: 16.75,
          speed: 15,
        })),
      };

      await service.processUpload('user-1', dto);

      const aggregateCall = (segmentRepo.query as jest.Mock).mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('weighted_readings'),
      );
      expect(aggregateCall).toBeUndefined();

      const createArg = (readingRepo.create as jest.Mock).mock.calls[0][0];
      expect(createArg.surface_type).toBeNull();
    });
  });

  describe('lean aggregation (US-19)', () => {
    function readingWithLean(
      lean: number | undefined,
      i: number,
    ): SensorReadingDto {
      return {
        t: Date.now() + i * 20,
        ax: 0.1,
        ay: 0.2,
        az: 9.8,
        lat: 49.1 + i * 0.00001,
        lng: 16.75,
        speed: 15,
        ...(lean !== undefined ? { lean_deg: lean } : {}),
      };
    }

    it('writes max_lean_angle and a bucketed histogram into ride_stats from the upload payload', async () => {
      const dto = {
        ride_id: 'ride-1',
        readings: [
          ...Array.from({ length: 5 }, (_, i) => readingWithLean(2, i)),
          ...Array.from({ length: 3 }, (_, i) => readingWithLean(15, i + 5)),
          // Negative leans count by absolute value — left and right
          // corners contribute to the same bucket.
          ...Array.from({ length: 4 }, (_, i) => readingWithLean(-22, i + 8)),
          readingWithLean(35, 12),
        ],
      };

      await service.processUpload('user-1', dto);

      // The sensor module always passes through findOne, then save —
      // assert against the storedStats trace instead of the spy index
      // so a future re-order of save calls doesn't break the test.
      expect(storedStats?.ride_id).toBe('ride-1');
      expect(storedStats?.max_lean_angle).toBe(35);
      expect(storedStats?.lean_distribution_json).toEqual({
        '0_10': 5,
        '10_20': 3,
        '20_30': 4,
        '30_plus': 1,
      });
    });

    it('merges new samples with the existing distribution instead of overwriting', async () => {
      // Pre-existing ride_stats row from a previous batch. The
      // aggregation should add the new histogram counts on top.
      storedStats = {
        ride_id: 'ride-1',
        max_lean_angle: 18,
        lean_distribution_json: {
          '0_10': 100,
          '10_20': 50,
          '20_30': 0,
          '30_plus': 0,
        },
      };

      const dto = {
        ride_id: 'ride-1',
        readings: [
          ...Array.from({ length: 2 }, (_, i) => readingWithLean(5, i)),
          ...Array.from({ length: 1 }, (_, i) => readingWithLean(28, i + 2)),
        ],
      };

      await service.processUpload('user-1', dto);

      expect(storedStats?.max_lean_angle).toBe(28);
      expect(storedStats?.lean_distribution_json).toEqual({
        '0_10': 102,
        '10_20': 50,
        '20_30': 1,
        '30_plus': 0,
      });
    });

    it("doesn't touch ride_stats when no readings carry lean data", async () => {
      const dto = {
        ride_id: 'ride-1',
        readings: Array.from({ length: 5 }, (_, i) =>
          readingWithLean(undefined, i),
        ),
      };

      await service.processUpload('user-1', dto);

      expect(statsRepo.query).not.toHaveBeenCalled();
      expect(storedStats).toBeNull();
    });

    it('persists lean samples even when every reading is filtered out by the GPS / speed gate', async () => {
      // Lean is derived from accel + gyro; GPS lock-acquisition,
      // tunnels, and stop-and-go traffic shouldn't cost the ride its
      // lean histogram. Without the upfront `upsertLeanStats` call,
      // the early return below would silently drop these samples.
      const dto = {
        ride_id: 'ride-1',
        readings: [
          // No GPS coordinates — dropped by the surface pipeline's
          // filter, but the rider's lean is still meaningful.
          {
            t: Date.now(),
            ax: 0.1,
            ay: 0.2,
            az: 9.8,
            lean_deg: 22,
          },
          {
            t: Date.now() + 20,
            ax: 0.1,
            ay: 0.2,
            az: 9.8,
            // Stopped (< 10 km/h) — also dropped by the GPS / speed
            // filter for the same reason.
            lat: 49.1,
            lng: 16.75,
            speed: 0.5,
            lean_deg: 8,
          },
        ],
      };

      const result = await service.processUpload('user-1', dto);

      expect(result.accepted).toBe(0);
      expect(result.segments_updated).toBe(0);
      expect(storedStats?.max_lean_angle).toBe(22);
      expect(storedStats?.lean_distribution_json).toEqual({
        '0_10': 1,
        '10_20': 0,
        '20_30': 1,
        '30_plus': 0,
      });
    });

    it('persists the merge through a single atomic upsert (no read-modify-write race)', async () => {
      // Two batches landing concurrently for the same ride must not
      // race on findOne → save: both would read the same baseline,
      // merge independently, and the second save would clobber the
      // first. The fix is to do the merge in SQL via INSERT ... ON
      // CONFLICT DO UPDATE — assert here that we issue exactly one
      // statement, with `ride_id` as the conflict target and
      // `GREATEST` / `jsonb_build_object` doing the merge in PG.
      const dto = {
        ride_id: 'ride-concurrency',
        readings: Array.from({ length: 3 }, (_, i) => readingWithLean(15, i)),
      };

      await service.processUpload('user-1', dto);

      expect(statsRepo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = (statsRepo.query as jest.Mock).mock.calls[0];
      expect(sql).toContain('INSERT INTO ride_stats');
      expect(sql).toContain('ON CONFLICT (ride_id) DO UPDATE');
      expect(sql).toContain('GREATEST');
      expect(sql).toContain('jsonb_build_object');
      expect(params[0]).toBe('ride-concurrency');
      expect(params[1]).toBe(15);
      expect(JSON.parse(params[2] as string)).toEqual({
        '0_10': 0,
        '10_20': 3,
        '20_30': 0,
        '30_plus': 0,
      });
    });
  });

  describe('processSegment speed handling', () => {
    it('should return null speedAvg when no readings have speed', () => {
      const readings: SensorReadingDto[] = Array.from(
        { length: 20 },
        (_, i) => ({
          t: Date.now() + i * 20,
          ax: 0.1,
          ay: 0.2,
          az: 9.8,
          lat: 49.1,
          lng: 16.75,
        }),
      );

      const result = service.processSegment(readings);

      expect(result).not.toBeNull();
      expect(result!.speedAvg).toBeNull();
    });
  });
});
