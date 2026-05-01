import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import {
  UploadSensorDataDto,
  SensorReadingDto,
} from './dto/upload-sensor-data.dto.js';
import { UploadResponseDto } from './dto/upload-response.dto.js';
import { haversineMeters, tallyLeanSamples } from '@tarmoto/shared';

const SEGMENT_LENGTH_M = 100;
const MIN_SPEED_MS = 2.78; // ~10 km/h — discard stopped readings

/** RMS thresholds matching the PoC sensor app and ML spec */
const QUALITY_THRESHOLDS: Array<{
  max: number;
  classification: string;
  score: number;
}> = [
  { max: 1.5, classification: 'excellent', score: 5 },
  { max: 3.0, classification: 'good', score: 4 },
  { max: 5.5, classification: 'fair', score: 3 },
  { max: 9.0, classification: 'poor', score: 2 },
  { max: Infinity, classification: 'very_poor', score: 1 },
];

interface ProcessedSegment {
  rms: number;
  classification: string;
  surfaceType: string | null;
  lat: number;
  lng: number;
  speedAvg: number | null;
  sampleCount: number;
  timestamp: Date;
}

@Injectable()
export class SensorService {
  private readonly logger = new Logger(SensorService.name);

  constructor(
    @InjectRepository(SurfaceReading)
    private readonly readingRepo: Repository<SurfaceReading>,
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
    @InjectRepository(RideStats)
    private readonly statsRepo: Repository<RideStats>,
  ) {}

  async processUpload(
    userId: string,
    dto: UploadSensorDataDto,
  ): Promise<UploadResponseDto> {
    // US-19 — fold this batch's lean samples into the per-ride
    // aggregation FIRST so they survive the GPS / speed filter the
    // surface-readings path applies below. Lean is derived from
    // accel + gyro and is GPS-independent: a batch captured during
    // GPS lock-acquisition, a tunnel, or stop-and-go traffic still
    // has valid `lean_deg` values that should land on the histogram.
    // Persisting before the early return keeps that data alive even
    // when no reading qualifies for the surface-readings pipeline.
    await this.upsertLeanStats(dto.ride_id, dto.readings);

    // Filter out readings without GPS or below speed threshold
    const validReadings = dto.readings.filter(
      (r) =>
        r.lat !== undefined &&
        r.lng !== undefined &&
        (r.speed === undefined || r.speed >= MIN_SPEED_MS),
    );

    if (validReadings.length === 0) {
      return { accepted: 0, segments_updated: 0 };
    }

    // Group readings into ~100m segments
    const segments = this.groupIntoSegments(validReadings);

    // Process each segment: calculate RMS, classify, match to road
    let segmentsUpdated = 0;
    for (const segment of segments) {
      const roadSegmentId = await this.findNearestRoadSegment(
        segment.lat,
        segment.lng,
      );

      if (!roadSegmentId) {
        this.logger.debug(
          `No road segment found near ${segment.lat},${segment.lng}`,
        );
        continue;
      }

      const reading = this.readingRepo.create({
        road_segment_id: roadSegmentId,
        ride_id: dto.ride_id,
        user_id: userId,
        iri_value: segment.rms,
        classification: segment.classification,
        surface_type: segment.surfaceType,
        vibration_rms: segment.rms,
        speed_at_reading:
          segment.speedAvg !== null ? segment.speedAvg * 3.6 : null,
        device_model: dto.device_model ?? null,
        // Telemetry: which client-side classifier was active at upload
        // time (US-3). The labels above were derived server-side from
        // the raw readings, so this column does NOT describe how
        // `classification` / `surface_type` were produced — it lets a
        // future change that trusts client window-level outputs filter
        // by classifier version. Null means the mobile fallback ran.
        client_model_version: dto.client_model_version ?? null,
        recorded_at: segment.timestamp,
      });

      await this.readingRepo.save(reading);
      segmentsUpdated++;
    }

    return {
      accepted: validReadings.length,
      segments_updated: segmentsUpdated,
    };
  }

  /**
   * Fold this batch's per-reading lean samples into the running
   * `ride_stats.max_lean_angle` and `ride_stats.lean_distribution_json`
   * for the ride. Called from `processUpload` after surface readings
   * have been persisted.
   *
   * Samples whose `lean_deg` is absent are dropped — the mobile filter
   * intentionally omits the field while calibrating, so treating
   * "missing" as 0° would over-fill the lowest bucket. Sub-windows are
   * tallied at the per-reading granularity (50 Hz) which over-counts
   * relative to the 1 s window granularity the spec calls out, but the
   * histogram still reports time-in-bucket faithfully because every
   * bucket scales by the same constant — what the rider sees is the
   * proportion in each bucket, not the absolute count.
   *
   * Concurrency: the merge is performed atomically by Postgres via
   * `INSERT ... ON CONFLICT (ride_id) DO UPDATE` rather than a JS-side
   * read-merge-write. Two batches for the same ride landing
   * concurrently (offline-queue replay racing a fresh upload) would
   * otherwise both read the same baseline, merge independently, and
   * have the second `save` clobber the first — silently losing a
   * batch's worth of histogram counts and potentially regressing
   * `max_lean_angle`. Doing the merge in SQL serialises on the
   * unique-index lookup for `ride_id`, so the second statement sees
   * the first's committed row in its `EXCLUDED` / `ride_stats.*`
   * references.
   */
  private async upsertLeanStats(
    rideId: string,
    readings: SensorReadingDto[],
  ): Promise<void> {
    // Pull the absolute-degree samples once and reuse for both the max
    // and the histogram tally so we don't walk the readings twice.
    const absSamples: number[] = [];
    let batchMax = 0;
    for (const r of readings) {
      if (r.lean_deg === undefined || !Number.isFinite(r.lean_deg)) continue;
      const abs = Math.abs(r.lean_deg);
      if (abs > batchMax) batchMax = abs;
      absSamples.push(abs);
    }
    if (absSamples.length === 0) {
      // Quiet sensor / pre-calibration batch — leave the row alone so
      // a follow-up batch with real lean data can still write to it.
      return;
    }
    const batchHistogram = tallyLeanSamples(absSamples);

    // The bucket keys are owned by `@tarmoto/shared` (`LEAN_BUCKETS`),
    // but inlining them here keeps the SQL stable across a future
    // schema change to the bucket set — adding a new bucket needs an
    // intentional edit to this statement, not an implicit drop on the
    // floor when the JSONB merge silently omits an unknown key.
    await this.statsRepo.query(
      `INSERT INTO ride_stats (ride_id, max_lean_angle, lean_distribution_json)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (ride_id) DO UPDATE SET
         max_lean_angle = GREATEST(
           COALESCE(ride_stats.max_lean_angle, 0),
           EXCLUDED.max_lean_angle
         ),
         lean_distribution_json = jsonb_build_object(
           '0_10',
             COALESCE((ride_stats.lean_distribution_json->>'0_10')::int, 0)
             + COALESCE((EXCLUDED.lean_distribution_json->>'0_10')::int, 0),
           '10_20',
             COALESCE((ride_stats.lean_distribution_json->>'10_20')::int, 0)
             + COALESCE((EXCLUDED.lean_distribution_json->>'10_20')::int, 0),
           '20_30',
             COALESCE((ride_stats.lean_distribution_json->>'20_30')::int, 0)
             + COALESCE((EXCLUDED.lean_distribution_json->>'20_30')::int, 0),
           '30_plus',
             COALESCE((ride_stats.lean_distribution_json->>'30_plus')::int, 0)
             + COALESCE((EXCLUDED.lean_distribution_json->>'30_plus')::int, 0)
         )`,
      [rideId, batchMax, JSON.stringify(batchHistogram)],
    );
  }

  /**
   * Group raw accelerometer readings into ~100m segments based on GPS distance.
   */
  groupIntoSegments(readings: SensorReadingDto[]): ProcessedSegment[] {
    const segments: ProcessedSegment[] = [];
    let segmentReadings: SensorReadingDto[] = [];
    let segmentDistance = 0;
    let lastLat = readings[0].lat!;
    let lastLng = readings[0].lng!;

    for (const reading of readings) {
      if (reading.lat !== undefined && reading.lng !== undefined) {
        const dist = haversineMeters(
          lastLat,
          lastLng,
          reading.lat,
          reading.lng,
        );
        segmentDistance += dist;
        lastLat = reading.lat;
        lastLng = reading.lng;
      }

      segmentReadings.push(reading);

      if (segmentDistance >= SEGMENT_LENGTH_M && segmentReadings.length > 0) {
        const processed = this.processSegment(segmentReadings);
        if (processed) {
          segments.push(processed);
        }
        segmentReadings = [];
        segmentDistance = 0;
      }
    }

    // Process remaining readings as a partial segment
    if (segmentReadings.length >= 10) {
      const processed = this.processSegment(segmentReadings);
      if (processed) {
        segments.push(processed);
      }
    }

    return segments;
  }

  /**
   * Process a segment of readings: calculate RMS, classify quality.
   */
  processSegment(readings: SensorReadingDto[]): ProcessedSegment | null {
    if (readings.length === 0) return null;

    // Calculate acceleration magnitude deviation from gravity
    const deviations = readings.map((r) => {
      const mag = Math.sqrt(r.ax ** 2 + r.ay ** 2 + r.az ** 2);
      return Math.abs(mag - 9.81);
    });

    const rms = Math.sqrt(
      deviations.reduce((sum, d) => sum + d * d, 0) / deviations.length,
    );

    const { classification } = classify(rms);
    const surfaceType = inferSurfaceType(deviations, rms);

    // Use centroid GPS position
    const gpsReadings = readings.filter(
      (r) => r.lat !== undefined && r.lng !== undefined,
    );
    if (gpsReadings.length === 0) return null;

    const midpoint = gpsReadings[Math.floor(gpsReadings.length / 2)];
    const speeds = readings
      .filter((r) => r.speed !== undefined)
      .map((r) => r.speed!);
    const speedAvg =
      speeds.length > 0
        ? speeds.reduce((a, b) => a + b, 0) / speeds.length
        : null;

    return {
      rms,
      classification,
      surfaceType,
      lat: midpoint.lat!,
      lng: midpoint.lng!,
      speedAvg,
      sampleCount: readings.length,
      timestamp: new Date(readings[Math.floor(readings.length / 2)].t),
    };
  }

  /**
   * Find the nearest road segment within 50m of a point.
   */
  private async findNearestRoadSegment(
    lat: number,
    lng: number,
  ): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.segmentRepo.query(
      `SELECT id FROM road_segments
       WHERE ST_DWithin(
         geom::geography,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         50
       )
       ORDER BY ST_Distance(
         geom::geography,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       )
       LIMIT 1`,
      [lng, lat],
    );

    const result = rows as Array<{ id: string }>;
    return result.length > 0 ? result[0].id : null;
  }
}

/** Classify road quality based on RMS vibration */
function classify(rms: number): { classification: string; score: number } {
  for (const threshold of QUALITY_THRESHOLDS) {
    if (rms < threshold.max) {
      return {
        classification: threshold.classification,
        score: threshold.score,
      };
    }
  }
  return { classification: 'very_poor', score: 1 };
}

function inferSurfaceType(deviations: number[], rms: number): string | null {
  if (deviations.length === 0) return null;

  const mean =
    deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
  let zeroCrossings = 0;
  for (let i = 1; i < deviations.length; i++) {
    if ((deviations[i] - mean) * (deviations[i - 1] - mean) < 0) {
      zeroCrossings++;
    }
  }

  const zeroCrossingRate = zeroCrossings / deviations.length;
  const peak = Math.max(...deviations);
  const crestFactor = rms > 0 ? peak / rms : 0;

  if (zeroCrossingRate > 0.4 && rms > 3.0) {
    return 'gravel';
  }
  if (crestFactor > 5.0 && rms > 3.0) {
    return 'cobblestone';
  }
  return null;
}
