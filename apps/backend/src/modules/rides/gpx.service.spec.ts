/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { GpxService } from './gpx.service.js';
import { Ride } from '../../entities/ride.entity.js';

describe('GpxService', () => {
  let service: GpxService;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;

  beforeEach(async () => {
    rideRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GpxService,
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
      ],
    }).compile();

    service = module.get<GpxService>(GpxService);
  });

  const validGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="49.1" lon="16.75"><time>2026-04-14T10:00:00Z</time></trkpt>
      <trkpt lat="49.2" lon="16.85"><time>2026-04-14T11:00:00Z</time></trkpt>
      <trkpt lat="49.3" lon="16.95"><time>2026-04-14T12:00:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

  const routeGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <rte>
    <rtept lat="49.1" lon="16.75"></rtept>
    <rtept lat="49.2" lon="16.85"></rtept>
  </rte>
</gpx>`;

  describe('parseGpxPoints', () => {
    it('should parse track points from standard GPX', () => {
      const points = service.parseGpxPoints(validGpx);

      expect(points).toHaveLength(3);
      expect(points[0]).toEqual({
        lat: 49.1,
        lng: 16.75,
        ele: undefined,
        time: new Date('2026-04-14T10:00:00Z'),
      });
    });

    it('should parse route points (<rte><rtept>)', () => {
      const points = service.parseGpxPoints(routeGpx);

      expect(points).toHaveLength(2);
      expect(points[0]!.lat).toBe(49.1);
    });

    it('should throw on invalid XML', () => {
      expect(() => service.parseGpxPoints('not xml')).toThrow(
        BadRequestException,
      );
    });

    it('should throw on missing gpx element', () => {
      expect(() => service.parseGpxPoints('<root><data/></root>')).toThrow(
        BadRequestException,
      );
    });

    it('should throw on empty GPX (no tracks or routes)', () => {
      expect(() => service.parseGpxPoints('<gpx version="1.1"></gpx>')).toThrow(
        BadRequestException,
      );
    });

    it('should handle GPX with elevation data', () => {
      const gpx = `<gpx version="1.1"><trk><trkseg>
        <trkpt lat="49.1" lon="16.75"><ele>350</ele></trkpt>
        <trkpt lat="49.2" lon="16.85"><ele>420</ele></trkpt>
      </trkseg></trk></gpx>`;

      const points = service.parseGpxPoints(gpx);

      expect(points[0]!.ele).toBe(350);
      expect(points[1]!.ele).toBe(420);
    });

    it('should handle multiple track segments', () => {
      const gpx = `<gpx version="1.1"><trk>
        <trkseg><trkpt lat="49.1" lon="16.75"/></trkseg>
        <trkseg><trkpt lat="49.2" lon="16.85"/></trkseg>
      </trk></gpx>`;

      const points = service.parseGpxPoints(gpx);
      expect(points).toHaveLength(2);
    });
  });

  describe('importGpx', () => {
    it('should create a completed ride from GPX', async () => {
      const buffer = Buffer.from(validGpx);
      const ride = await service.importGpx('user-1', buffer);

      expect(rideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          ride_type: 'tracked',
          status: 'completed',
        }),
      );
      expect(ride.distance_km).toBeGreaterThan(0);
      expect(ride.route_geom).toBeDefined();
    });

    it('should reject GPX with fewer than 2 points', async () => {
      const gpx = `<gpx version="1.1"><trk><trkseg>
        <trkpt lat="49.1" lon="16.75"/>
      </trkseg></trk></gpx>`;

      await expect(
        service.importGpx('user-1', Buffer.from(gpx)),
      ).rejects.toThrow(BadRequestException);
    });

    it('should calculate distance from track points', async () => {
      const buffer = Buffer.from(validGpx);
      const ride = await service.importGpx('user-1', buffer);

      // ~22km between the 3 points
      expect(ride.distance_km).toBeGreaterThan(10);
      expect(ride.distance_km).toBeLessThan(50);
    });
  });
});
