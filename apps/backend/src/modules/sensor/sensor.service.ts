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
        vibration_rms: segment.rms,
        speed_at_reading:
          segment.speedAvg !== null ? segment.speedAvg * 3.6 : null,
        device_model: dto.device_model ?? null,
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
        const dist = haversineMeters(lastLat, lastLng, reading.lat, reading.lng);
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

