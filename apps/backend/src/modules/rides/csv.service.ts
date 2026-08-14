import { Injectable } from '@nestjs/common';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';

export interface RideWithStats {
  ride: Ride;
  stats: RideStats | null;
}

const HEADERS = [
  'id',
  'started_at',
  'ended_at',
  'ride_type',
  'status',
  'distance_km',
  'duration_min',
  'avg_speed',
  'max_speed',
  'avg_road_quality',
  'elevation_gain',
  'elevation_loss',
  'curve_count',
  'max_lean_angle',
  'fuel_estimate_l',
] as const;

@Injectable()
export class CsvService {
  /**
   * `includeQuality` gates `avg_road_quality` the same way, for the
   * `road_quality_overlay` operator kill: the export itself stays available
   * (distance, speed and duration are not road-quality data), but the killed
   * metric must not travel out through it while the pages that render it are
   * gated. Header kept, value nulled, so the CSV shape stays stable.
   *
   * `includeAdvanced` gates the `advanced_ride_stats` (Pro) columns —
   * `elevation_gain`, `elevation_loss`, `max_lean_angle` — the same fields
   * `stripAdvancedRideStats` nulls on the JSON read paths. Defaults to `true`
   * so existing callers (and the pre-existing test suite) are unaffected;
   * `RidesService` passes the resolved entitlement explicitly. The header
   * (and column order) never changes — only the cell VALUES are blanked —
   * so the CSV shape is identical for every viewer.
   */
  buildRidesCsv(
    entries: RideWithStats[],
    includeAdvanced = true,
    includeQuality = true,
  ): string {
    const lines = [HEADERS.join(',')];
    for (const entry of entries) {
      lines.push(
        this.rowFor(entry.ride, entry.stats, includeAdvanced, includeQuality),
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  buildRideCsv(
    ride: Ride,
    stats: RideStats | null,
    includeAdvanced = true,
    includeQuality = true,
  ): string {
    return (
      [
        HEADERS.join(','),
        this.rowFor(ride, stats, includeAdvanced, includeQuality),
      ].join('\r\n') + '\r\n'
    );
  }

  private rowFor(
    ride: Ride,
    stats: RideStats | null,
    includeAdvanced: boolean,
    includeQuality: boolean,
  ): string {
    const values: Array<string | number | null> = [
      ride.id,
      ride.started_at.toISOString(),
      ride.ended_at?.toISOString() ?? null,
      ride.ride_type,
      ride.status,
      ride.distance_km,
      this.durationMin(ride),
      ride.avg_speed,
      ride.max_speed,
      includeQuality ? ride.avg_road_quality : null,
      includeAdvanced ? (stats?.elevation_gain ?? null) : null,
      includeAdvanced ? (stats?.elevation_loss ?? null) : null,
      stats?.curve_count ?? null,
      includeAdvanced ? (stats?.max_lean_angle ?? null) : null,
      stats?.fuel_estimate_l ?? null,
    ];
    return values.map((v) => this.escape(v)).join(',');
  }

  private durationMin(ride: Ride): number | null {
    if (!ride.ended_at) return null;
    return Math.round(
      (ride.ended_at.getTime() - ride.started_at.getTime()) / 60000,
    );
  }

  /**
   * RFC 4180 field escape: wrap in double-quotes when the value contains a
   * comma, double-quote, CR or LF; embedded quotes are doubled.
   */
  private escape(value: string | number | null): string {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'string' ? value : String(value);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}
