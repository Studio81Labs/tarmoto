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

    it('withholds avg_road_quality when road_quality_overlay is killed', () => {
      // The export itself stays available — distance, speed and duration are
      // not road-quality data. Only the killed metric's VALUE is withheld,
      // the same shape as the advanced_ride_stats columns, so the CSV schema
      // does not change under an operator flip.
      const live = service.buildRideCsv(ride, stats, true, true);
      expect(live.trimEnd().split('\r\n')[1]).toContain('4.1');

      const killed = service.buildRideCsv(ride, stats, true, false);
      const lines = killed.trimEnd().split('\r\n');
      // Header unchanged: consumers parsing by column position keep working.
      expect(lines[0]).toContain('avg_road_quality');
      expect(lines[1]).not.toContain('4.1');
      // Everything else still exported.
      expect(lines[1]).toContain('85.4');
      expect(lines[1]).toContain('62');
    });

    it('emits empty strings for nulls (not the literal "null")', () => {
      const csv = service.buildRideCsv(
        { ...ride, ended_at: null, distance_km: null, avg_speed: null },
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

  describe('buildRidesCsv — road_quality_overlay', () => {
    it('withholds avg_road_quality from EVERY row when killed', () => {
      // The bulk path takes `includeQuality` as a separate positional
      // argument, so a refactor that drops or misorders it would restore the
      // metric in /rides/export.csv while the single-ride tests still pass.
      const entries = [
        { ride: { ...ride, id: 'ride-1', avg_road_quality: 4.1 }, stats },
        { ride: { ...ride, id: 'ride-2', avg_road_quality: 2.7 }, stats },
      ] as never;

      const live = service.buildRidesCsv(entries, true, true);
      expect(live).toContain('4.1');
      expect(live).toContain('2.7');

      const killed = service.buildRidesCsv(entries, true, false);
      const rows = killed.trimEnd().split('\r\n').slice(1);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).not.toContain('4.1');
        expect(row).not.toContain('2.7');
        // Unrelated fields survive in every row.
        expect(row).toContain('85.4');
      }
      // Header unchanged, so the CSV shape is stable across a flip.
      expect(killed.split('\r\n')[0]).toContain('avg_road_quality');
    });
  });

  describe('buildRidesCsv', () => {
    it('emits header + one row per ride', () => {
      const second = { ...ride, id: 'ride-2' };
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

  describe('includeAdvanced gating (advanced_ride_stats paywall)', () => {
    it('defaults to including advanced columns when the arg is omitted', () => {
      const csv = service.buildRideCsv(ride, stats);
      expect(csv).toContain('250'); // elevation_gain
      expect(csv).toContain('240'); // elevation_loss
      expect(csv).toContain('32'); // max_lean_angle
    });

    it('blanks elevation_gain/elevation_loss/max_lean_angle when includeAdvanced is false', () => {
      const csv = service.buildRideCsv(ride, stats, false);
      const row = csv.trimEnd().split('\r\n')[1].split(',');

      // Row shape: id, started_at, ended_at, ride_type, status,
      // distance_km, duration_min, avg_speed, max_speed,
      // avg_road_quality, elevation_gain, elevation_loss, curve_count,
      // max_lean_angle, fuel_estimate_l
      expect(row[10]).toBe(''); // elevation_gain
      expect(row[11]).toBe(''); // elevation_loss
      expect(row[13]).toBe(''); // max_lean_angle
    });

    it('keeps basic stats and the non-advanced curve_count/fuel_estimate_l intact when gated', () => {
      const csv = service.buildRideCsv(ride, stats, false);
      const row = csv.trimEnd().split('\r\n')[1].split(',');

      expect(row[0]).toBe('ride-1');
      expect(row[5]).toBe('85.4'); // distance_km
      expect(row[12]).toBe('18'); // curve_count — not advanced
      expect(row[14]).toBe('4.8'); // fuel_estimate_l — not advanced
    });

    it('keeps the HEADER identical regardless of includeAdvanced', () => {
      const entitled = service.buildRideCsv(ride, stats, true).split('\r\n')[0];
      const gated = service.buildRideCsv(ride, stats, false).split('\r\n')[0];
      expect(gated).toBe(entitled);
      expect(gated).toBe(
        'id,started_at,ended_at,ride_type,status,distance_km,duration_min,avg_speed,max_speed,avg_road_quality,elevation_gain,elevation_loss,curve_count,max_lean_angle,fuel_estimate_l',
      );
    });

    it('threads includeAdvanced through buildRidesCsv for every row', () => {
      const second = { ...ride, id: 'ride-2' };
      const csv = service.buildRidesCsv(
        [
          { ride, stats },
          { ride: second, stats },
        ],
        false,
      );
      const lines = csv.trimEnd().split('\r\n');
      const row1 = lines[1].split(',');
      const row2 = lines[2].split(',');

      expect(row1[13]).toBe(''); // max_lean_angle gated
      expect(row2[13]).toBe(''); // max_lean_angle gated
    });
  });

  describe('escaping', () => {
    it('quotes and doubles embedded double-quotes', () => {
      const quirky = { ...ride, ride_type: 'free "weekend"' };
      const csv = service.buildRideCsv(quirky, stats);
      expect(csv).toContain('"free ""weekend"""');
    });

    it('quotes values containing commas', () => {
      const quirky = { ...ride, status: 'paused,completed' };
      const csv = service.buildRideCsv(quirky, stats);
      expect(csv).toContain('"paused,completed"');
    });

    it('quotes values containing newlines', () => {
      const quirky = { ...ride, ride_type: 'free\nride' };
      const csv = service.buildRideCsv(quirky, stats);
      expect(csv).toContain('"free\nride"');
    });
  });
});
