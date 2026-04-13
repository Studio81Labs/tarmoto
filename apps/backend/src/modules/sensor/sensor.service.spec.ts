/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SensorService } from './sensor.service.js';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { SensorReadingDto } from './dto/upload-sensor-data.dto.js';

describe('SensorService', () => {
  let service: SensorService;
  let readingRepo: jest.Mocked<Partial<Repository<SurfaceReading>>>;
  let segmentRepo: jest.Mocked<Partial<Repository<RoadSegment>>>;

  beforeEach(async () => {
    readingRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    segmentRepo = {
      query: jest.fn().mockResolvedValue([{ id: 'segment-1' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorService,
        { provide: getRepositoryToken(SurfaceReading), useValue: readingRepo },
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
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
