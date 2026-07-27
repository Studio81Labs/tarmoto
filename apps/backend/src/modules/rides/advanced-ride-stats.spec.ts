import { stripAdvancedRideStats } from './advanced-ride-stats.js';
import type { RideDetailDto, RideSummaryDto } from './dto/ride-response.dto.js';

const full = {
  id: 'r1',
  distance_km: 42.5,
  avg_speed: 45,
  avg_road_quality: 4,
  max_lean_angle: 38,
  lean_distribution: { lt10: 1, from10to20: 2, from20to30: 3, gte30: 4 },
  elevation_gain: 320,
  elevation_loss: 280,
  segments: [
    {
      road_segment_id: 's1',
      quality_reading: 4,
      speed_avg: 40,
      speed_max: 60,
      lean_angle_max: 30,
    },
  ],
  // Cast rather than fill in every RideDetailDto field (status, ride_type,
  // started_at, ...) — this fixture only exercises the advanced-stats
  // shape the helper reads/writes.
} as unknown as RideDetailDto;

it('nulls advanced fields but keeps basic ones', () => {
  const stripped = stripAdvancedRideStats(full);
  const segment = stripped.segments[0]!;

  expect(stripped.max_lean_angle).toBeNull();
  expect(stripped.lean_distribution).toBeNull();
  expect(stripped.elevation_gain).toBeNull();
  expect(stripped.elevation_loss).toBeNull();
  expect(segment.lean_angle_max).toBeNull();
  // basic fields intact
  expect(stripped.distance_km).toBe(42.5);
  expect(stripped.avg_speed).toBe(45);
  expect(stripped.avg_road_quality).toBe(4);
  expect(segment.quality_reading).toBe(4);
  expect(segment.speed_max).toBe(60);
});

it('does not mutate the input', () => {
  const before = full.max_lean_angle;
  stripAdvancedRideStats(full);
  expect(full.max_lean_angle).toBe(before);
});

it('nulls only the summary-level max_lean_angle when segments are absent (list path)', () => {
  // RideSummaryDto (the list-row shape) has no `segments` /
  // `lean_distribution` / `elevation_gain` / `elevation_loss` — only
  // `max_lean_angle` is an advanced field here.
  const summary: RideSummaryDto = {
    id: 'r2',
    status: 'completed',
    ride_type: 'free',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    distance_km: 10,
    avg_speed: 30,
    avg_road_quality: 3,
    avg_curviness: null,
    bike_id: null,
    name: null,
    duration_min: 20,
    max_lean_angle: 33,
  };

  const stripped = stripAdvancedRideStats(summary);

  expect(stripped.max_lean_angle).toBeNull();
  expect(stripped.distance_km).toBe(10);
  expect(stripped.duration_min).toBe(20);
  expect(stripped).not.toHaveProperty('segments');
});
