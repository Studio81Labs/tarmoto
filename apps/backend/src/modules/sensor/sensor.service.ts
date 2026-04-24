import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import {
  UploadSensorDataDto,
  SensorReadingDto,
} from './dto/upload-sensor-data.dto.js';
import { UploadResponseDto } from './dto/upload-response.dto.js';
import { haversineMeters } from '@tarmoto/shared';

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
  surfaceType: string;
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
  ) {}

  async processUpload(
    userId: string,
    dto: UploadSensorDataDto,
  ): Promise<UploadResponseDto> {
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
        recorded_at: segment.timestamp,
      });

      await this.readingRepo.save(reading);
      await this.refreshRoadSegmentAggregate(roadSegmentId);
      segmentsUpdated++;
    }

    return {
      accepted: validReadings.length,
      segments_updated: segmentsUpdated,
    };
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

  private async refreshRoadSegmentAggregate(
    roadSegmentId: string,
  ): Promise<void> {
    await this.segmentRepo.query(
      `WITH weighted_readings AS (
         SELECT
           CASE classification
             WHEN 'excellent' THEN 5.0
             WHEN 'good' THEN 4.0
             WHEN 'fair' THEN 3.0
             WHEN 'poor' THEN 2.0
             WHEN 'very_poor' THEN 1.0
           END AS quality_score,
           CASE
             WHEN recorded_at >= NOW() - INTERVAL '30 days' THEN 1.0
             WHEN recorded_at >= NOW() - INTERVAL '90 days' THEN 0.7
             WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
             ELSE 0.2
           END AS recency_weight,
           surface_type,
           user_id,
           recorded_at
         FROM surface_readings
         WHERE road_segment_id = $1
       ),
       reading_stats AS (
         SELECT
           SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
           COUNT(*)::int AS reading_count,
           COUNT(DISTINCT user_id)::int AS unique_rider_count
         FROM weighted_readings
         WHERE quality_score IS NOT NULL
       ),
       surface_mode AS (
         SELECT surface_type
         FROM weighted_readings
         WHERE surface_type IS NOT NULL
         GROUP BY surface_type
         ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC
         LIMIT 1
       )
       UPDATE road_segments rs
       SET
         quality_score = stats.quality_score,
         reading_count = stats.reading_count,
         confidence = CASE
           WHEN stats.reading_count >= 20 AND stats.unique_rider_count >= 5 THEN 100
           WHEN stats.reading_count >= 10 THEN 90
           WHEN stats.reading_count >= 5 THEN 70
           WHEN stats.reading_count >= 3 THEN 50
           WHEN stats.reading_count >= 1 THEN 20
           ELSE 0
         END,
         surface_type = COALESCE((SELECT surface_type FROM surface_mode), rs.surface_type),
         last_updated = NOW()
       FROM reading_stats stats
       WHERE rs.id = $1`,
      [roadSegmentId],
    );
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

function inferSurfaceType(deviations: number[], rms: number): string {
  if (deviations.length === 0) return 'unknown';

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
  if (crestFactor > 5.0) {
    return 'cobblestone';
  }
  return 'asphalt';
}
