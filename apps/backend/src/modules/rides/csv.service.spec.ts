import { Test, TestingModule } from '@nestjs/testing';
import { CsvService } from './csv.service.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';

describe('CsvService', () => {
  let service: CsvService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CsvService],
    }).compile();

    service = module.get<CsvService>(CsvService);
  });

  const ride = {
    id: 'ride-1',
    user_id: 'user-1',
    ride_type: 'free',
    status: 'completed',
    started_at: new Date('2026-04-14T10:00:00Z'),
    ended_at: new Date('2026-04-14T11:30:00Z'),
    distance_km: 85.4,
    avg_speed: 62,
    max_speed: 95,
    route_geom: null,
    avg_road_quality: 4.1,
  } as Ride;

  const stats = {
    elevation_gain: 250,
    elevation_loss: 240,
    curve_count: 18,
    max_lean_angle: 32,
    fuel_estimate_l: 4.8,
  } as RideStats;

  describe('buildRideCsv', () => {
    it('emits header + one data row', () => {
      const csv = service.buildRideCsv(ride, stats);
      const lines = csv.trimEnd().split('\r\n');

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('id,started_at,ended_at');
      expect(lines[1]).toContain('ride-1');
      expect(lines[1]).toContain('85.4');
      expect(lines[1]).toContain('90'); // duration_min
    });

    it('emits empty strings for nulls (not the literal "null")', () => {
      const csv = service.buildRideCsv(
        { ...ride, ended_at: null, distance_km: null, avg_speed: null } as Ride,
        null,
      );
      const row = csv.trimEnd().split('\r\n')[1].split(',');

      // Row shape: id, started_at, ended_at, ride_type, status, distance_km, …
      expect(row[2]).toBe(''); // ended_at null
      expect(row[5]).toBe(''); // distance_km null
      expect(row[7]).toBe(''); // avg_speed null
      expect(row[10]).toBe(''); // elevation_gain (stats null)
    });

    it('uses CRLF terminator', () => {
      const csv = service.buildRideCsv(ride, stats);
      expect(csv.endsWith('\r\n')).toBe(true);
      expect(csv.split('\r\n')).toHaveLength(3); // header, row, trailing empty
    });

    it('rounds duration_min from started_at/ended_at', () => {
      const csv = service.buildRideCsv(ride, stats);
      const row = csv.trimEnd().split('\r\n')[1].split(',');
      expect(row[6]).toBe('90');
    });
  });

  describe('buildRidesCsv', () => {
    it('emits header + one row per ride', () => {
      const second = { ...ride, id: 'ride-2' } as Ride;
      const csv = service.buildRidesCsv([
        { ride, stats },
        { ride: second, stats: null },
      ]);
      const lines = csv.trimEnd().split('\r\n');

      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('ride-1');
      expect(lines[2]).toContain('ride-2');
    });

    it('returns just the header for an empty list', () => {
      const csv = service.buildRidesCsv([]);
      const lines = csv.trimEnd().split('\r\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('id,started_at,ended_at');
    });
  });

  describe('escaping', () => {
    it('quotes and doubles embedded double-quotes', () => {
      const quirky = { ...ride, ride_type: 'free "weekend"' } as Ride;
      const csv = service.buildRideCsv(quirky, stats);
      expect(csv).toContain('"free ""weekend"""');
    });

    it('quotes values containing commas', () => {
      const quirky = { ...ride, status: 'paused,completed' } as Ride;
      const csv = service.buildRideCsv(quirky, stats);
      expect(csv).toContain('"paused,completed"');
    });

    it('quotes values containing newlines', () => {
      const quirky = { ...ride, ride_type: 'free\nride' } as Ride;
      const csv = service.buildRideCsv(quirky, stats);
      expect(csv).toContain('"free\nride"');
    });
  });
});
