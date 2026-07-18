import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideTagEvent } from '../../entities/ride-tag-event.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { ModelEvalService } from '../model-eval/model-eval.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { SERVER_HEURISTIC_MODEL_VERSION } from '../model-eval/model-eval.constants.js';
import {
  UploadSensorDataDto,
  SensorReadingDto,
  RideTagEventDto,
  CalibrationDto,
} from './dto/upload-sensor-data.dto.js';
import { UploadResponseDto } from './dto/upload-response.dto.js';
import {
  haversineMeters,
  tallyLeanSamples,
  resolveTagForTimestamp,
  SURFACE_LABEL_TO_TRUTH,
  classifyCalibrationQuality,
  encodeDeviceFamily,
  type CalibrationQuality,
  type RideTagEvent as RideTagEventPayload,
} from '@tarmoto/shared';

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
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideStats)
    private readonly statsRepo: Repository<RideStats>,
    @InjectRepository(RideTagEvent)
    private readonly tagEventRepo: Repository<RideTagEvent>,
    private readonly privacy: PrivacyPreferencesService,
    private readonly modelEval: ModelEvalService,
    private readonly featureResolver: FeatureResolver,
  ) {}

  async processUpload(
    userId: string,
    dto: UploadSensorDataDto,
  ): Promise<UploadResponseDto> {
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_surface_upload'))
    ) {
      throw new ServiceUnavailableException(
        'Sensor upload is temporarily unavailable',
      );
    }

    // #279 — honor the rider's road-data contribution opt-out. When
    // disabled we 202 (matching the controller status) without
    // persisting any surface readings or rider tag events (issue #7);
    // both carry road-quality + location data and are exactly the
    // contribution the toggle suppresses. Lean stats still update
    // because they're personal-history data the rider sees on their
    // own ride detail screen, never aggregated into the public
    // road-quality map. Returning 202 (not 403) keeps the mobile
    // uploader's offline retry loop quiet — the contribution is
    // intentionally silent.
    const prefs = await this.privacy.loadPreferences(userId);
    if (!prefs.road_data_contribution) {
      await this.upsertLeanStats(dto.ride_id, dto.readings);
      return { accepted: 0, segments_updated: 0 };
    }

    // Issue #494 — classify and persist the idle-baseline calibration
    // BEFORE the readings pipeline so the per-row tag is available for
    // every persisted `surface_readings` row in this batch. The
    // calibration write is a first-write-wins UPDATE on the ride row:
    // a ride that uploads across multiple batches (offline-queue
    // replay) ships the same calibration on every batch, and the
    // first one to land sets the value.
    let calibrationQuality: CalibrationQuality | null = null;
    if (dto.calibration) {
      calibrationQuality = classifyCalibrationQuality(dto.calibration);
      if (calibrationQuality === 'poor') {
        // Surface in logs so an ops dashboard can correlate spikes in
        // poor-calibration uploads against device-model rollouts.
        // Don't reject the row — even a poor calibration is signal,
        // just lower-weight downstream.
        this.logger.warn(
          `Calibration flagged poor for ride ${dto.ride_id}: ` +
            `std=(${dto.calibration.axis_std_x.toFixed(3)}, ` +
            `${dto.calibration.axis_std_y.toFixed(3)}, ` +
            `${dto.calibration.axis_std_z.toFixed(3)}) ` +
            `samples=${dto.calibration.sample_count} ` +
            `truncated=${dto.calibration.truncated}`,
        );
      }
      await this.persistRideCalibration(
        dto.ride_id,
        userId,
        dto.calibration,
        calibrationQuality,
      );
    }
    const deviceFamily = dto.device_model
      ? encodeDeviceFamily(dto.device_model)
      : null;

    // Research issue #7 — persist rider tags BEFORE the readings
    // pipeline so they survive the empty-readings early return below
    // (a batch with only a tag tap and no GPS-locked readings should
    // still leave a `ride_tag_events` row for the spike). The privacy
    // opt-out path above is intentionally upstream of this — see
    // `road_data_contribution` comment for why opted-out riders must
    // not leave tag rows behind.
    const sortedTagEvents = await this.persistTagEvents(
      userId,
      dto.ride_id,
      dto.tag_events,
    );

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

    // Issue #494 — when the upload includes a `'good'` calibration,
    // use the rider's calibrated rest magnitude in place of the
    // canonical 9.81 for the per-segment RMS computation. That
    // keeps the persisted `vibration_rms` and `classification` in
    // the same scalar-deviation domain as the row's
    // `calibration_quality: 'good'` tag advertises — without this,
    // calibrated rides would still persist uncalibrated RMS values
    // even though `surface_readings.calibration_quality` says
    // they're trustworthy. Poor calibrations stay on the 9.81
    // baseline so a contaminated bias can't shift the persisted
    // values; absent calibrations also stay on 9.81.
    const calibrationRestMag =
      dto.calibration && calibrationQuality === 'good'
        ? Math.sqrt(
            dto.calibration.axis_mean_x * dto.calibration.axis_mean_x +
              dto.calibration.axis_mean_y * dto.calibration.axis_mean_y +
              dto.calibration.axis_mean_z * dto.calibration.axis_mean_z,
          )
        : undefined;

    // Group readings into ~100m segments
    const segments = this.groupIntoSegments(validReadings, calibrationRestMag);

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

      // Research issue #7 — resolve the rider tag (if any) covering
      // this segment's midpoint timestamp. `null` when the rider had
      // no tag active for the covering window, which is the common
      // case for any rider not actively running the labelling UI.
      const tag = resolveTagForTimestamp(
        sortedTagEvents,
        segment.timestamp.getTime(),
      );
      const truth = tag ? SURFACE_LABEL_TO_TRUTH[tag.label] : null;

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
        // Issue #494 — coarse device family bucket alongside the raw
        // model string. Stored on every row so training queries can
        // group without re-running the encoder over historical data.
        device_family: deviceFamily,
        // Issue #494 — `'good'` / `'poor'` validation tag for the
        // upload's calibration block, or null when the upload didn't
        // ship one.
        calibration_quality: calibrationQuality,
        // Telemetry: which client-side classifier was active at upload
        // time (US-3). The labels above were derived server-side from
        // the raw readings, so this column does NOT describe how
        // `classification` / `surface_type` were produced — it lets a
        // future change that trusts client window-level outputs filter
        // by classifier version. Null means the mobile fallback ran.
        client_model_version: dto.client_model_version ?? null,
        // Telemetry: which on-device preprocessing pipeline produced
        // this batch's `ax/ay/az` (issue #493). `lp22-v1` for
        // post-filter clients, null for raw-axis clients. Persisting
        // per-row lets training queries cleanly separate the two
        // regimes without forcing a column-level split.
        client_preprocessing_version: dto.client_preprocessing_version ?? null,
        // Research issue #7 — rider-asserted ground truth, kept
        // alongside the heuristic-derived columns above so research
        // queries can compare the two without re-running the join.
        rider_surface_label: tag?.label ?? null,
        rider_quality_label: truth?.quality_label ?? null,
        recorded_at: segment.timestamp,
      });

      const saved = await this.readingRepo.save(reading);
      segmentsUpdated++;

      // Issue #496 — feed the online ML evaluation pipeline. Sampling
      // is rate-limited inside `maybeSample` (default 1%), and a
      // failure here must NEVER fail the upload — it's pure
      // telemetry. Wrapping in try/catch is appropriate here even
      // though AGENTS.md discourages broad swallows: the path is
      // strictly best-effort and the underlying writes are still
      // observable through the regular logger.
      //
      // `model_version` is intentionally NOT `dto.client_model_version`
      // — see `SERVER_HEURISTIC_MODEL_VERSION` for why. The upload
      // contract today carries raw accelerometer readings; the
      // `segment.classification` we just persisted was produced by
      // the **server-side RMS heuristic**, not by the client's TF
      // Lite model. Tagging samples with the client's version would
      // mis-attribute heuristic regressions to a phantom client
      // model, so we tag with the heuristic marker instead. When the
      // upload contract grows a per-segment client prediction, swap
      // this to `dto.client_model_version` for samples that carry it.
      try {
        await this.modelEval.maybeSample({
          surface_reading_id: saved.id,
          road_segment_id: roadSegmentId,
          ride_id: dto.ride_id,
          user_id: userId,
          model_version: SERVER_HEURISTIC_MODEL_VERSION,
          device_model: dto.device_model ?? null,
          predicted_classification: segment.classification,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `model-eval sampling failed for reading ${saved.id}: ${msg}`,
        );
      }
    }

    return {
      accepted: validReadings.length,
      segments_updated: segmentsUpdated,
    };
  }

  /**
   * Persist a batch of rider-asserted surface tags (research issue #7)
   * and return the same events sorted ascending by `t` for the per-
   * segment join in `processUpload`. Returns `[]` when the client
   * sent no tags so the join short-circuits without walking an empty
   * array.
   *
   * Tags are saved verbatim (not deduplicated against any prior batch)
   * because each tap is a discrete rider intent — the same upload
   * being retried by the offline queue would re-send the same tags,
   * but the `(ride_id, user_id, t, label)` quadruple is the natural
   * forensic key and we accept the duplication rather than silently
   * dropping a rider tap on a network glitch. The join is idempotent
   * regardless: it picks the most recent span tag at any timestamp,
   * so a duplicate `t` row produces the same label.
   */
  private async persistTagEvents(
    userId: string,
    rideId: string,
    events: RideTagEventDto[] | undefined,
  ): Promise<RideTagEventPayload[]> {
    if (!events || events.length === 0) return [];
    const rows = events.map((ev) =>
      this.tagEventRepo.create({
        ride_id: rideId,
        user_id: userId,
        t: String(ev.t),
        lat: ev.lat ?? null,
        lng: ev.lng ?? null,
        label: ev.label,
      }),
    );
    await this.tagEventRepo.save(rows);
    return [...events]
      .map<RideTagEventPayload>((ev) => ({
        t: ev.t,
        ...(ev.lat !== undefined ? { lat: ev.lat } : {}),
        ...(ev.lng !== undefined ? { lng: ev.lng } : {}),
        label: ev.label,
      }))
      .sort((a, b) => a.t - b.t);
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
   *
   * `restMag` is the rider's calibrated rest accelerometer magnitude
   * (issue #494 — `‖calibration.axis_mean‖` from a `'good'` upload).
   * When passed, it replaces the literal 9.81 in the per-segment RMS
   * computation so the persisted `vibration_rms` / `classification`
   * land in the same scalar-deviation domain as the row's
   * `calibration_quality: 'good'` tag advertises. Omit / pass
   * `undefined` to keep the historical 9.81 baseline (no calibration
   * uploaded, or quality flagged poor).
   */
  groupIntoSegments(
    readings: SensorReadingDto[],
    restMag?: number,
  ): ProcessedSegment[] {
    const segments: ProcessedSegment[] = [];
    let segmentReadings: SensorReadingDto[] = [];
    let segmentDistance = 0;
    const first = readings[0];
    if (!first) return segments;
    let lastLat = first.lat!;
    let lastLng = first.lng!;

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
        const processed = this.processSegment(segmentReadings, restMag);
        if (processed) {
          segments.push(processed);
        }
        segmentReadings = [];
        segmentDistance = 0;
      }
    }

    // Process remaining readings as a partial segment
    if (segmentReadings.length >= 10) {
      const processed = this.processSegment(segmentReadings, restMag);
      if (processed) {
        segments.push(processed);
      }
    }

    return segments;
  }

  /**
   * Process a segment of readings: calculate RMS, classify quality.
   *
   * `restMag` (issue #494) substitutes the calibrated rider rest
   * magnitude `‖calibration.axis_mean‖` for the canonical 9.81 when
   * the upload's calibration was tagged `'good'`. This keeps the
   * persisted `vibration_rms` / `classification` consistent with the
   * row's `calibration_quality` tag — without it, a calibrated ride
   * would still produce uncalibrated RMS values, and downstream
   * queries that trust `'good'` rows would consume biased data.
   */
  processSegment(
    readings: SensorReadingDto[],
    restMag: number = 9.81,
  ): ProcessedSegment | null {
    if (readings.length === 0) return null;

    // Calculate acceleration magnitude deviation from the rider's
    // calibrated rest baseline (or the canonical 9.81 fallback).
    const deviations = readings.map((r) => {
      const mag = Math.sqrt(r.ax ** 2 + r.ay ** 2 + r.az ** 2);
      return Math.abs(mag - restMag);
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
    if (!midpoint) return null;
    const midReading = readings[Math.floor(readings.length / 2)];
    if (!midReading) return null;
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
      timestamp: new Date(midReading.t),
    };
  }

  /**
   * Persist the upload's idle-baseline calibration block onto the
   * ride row (issue #494). First-write-wins semantics: a ride that
   * uploads across multiple batches (offline-queue replay racing a
   * fresh upload, or a long ride split into chunks) ships the same
   * calibration on every batch, so once the first batch has written
   * the values the subsequent batches must NOT clobber them.
   *
   * The conditional UPDATE keys on a single nullable column
   * (`calibration_axis_mean_x`) — all calibration columns are written
   * as a unit, so seeing one populated guarantees the rest are too.
   * Doing this in SQL means the check is atomic against concurrent
   * uploads (no read-modify-write race) and we don't need a separate
   * lock or version column.
   *
   * `userId` scopes the UPDATE to rides owned by the caller. Without
   * the ownership predicate, a malicious client that learns or
   * guesses another rider's ride UUID could submit a fabricated
   * calibration on that ride's first-write-wins window and pin
   * arbitrary attacker-controlled values in the DB. The
   * `(id, user_id)` pair is the smallest authorization gate that
   * also keeps the UPDATE atomic against concurrent uploads.
   */
  private async persistRideCalibration(
    rideId: string,
    userId: string,
    calibration: CalibrationDto,
    quality: CalibrationQuality,
  ): Promise<void> {
    await this.rideRepo
      .createQueryBuilder()
      .update(Ride)
      .set({
        calibration_axis_mean_x: calibration.axis_mean_x,
        calibration_axis_mean_y: calibration.axis_mean_y,
        calibration_axis_mean_z: calibration.axis_mean_z,
        calibration_axis_std_x: calibration.axis_std_x,
        calibration_axis_std_y: calibration.axis_std_y,
        calibration_axis_std_z: calibration.axis_std_z,
        calibration_sample_count: calibration.sample_count,
        calibration_truncated: calibration.truncated,
        calibration_quality: quality,
      })
      .where('id = :rideId', { rideId })
      .andWhere('user_id = :userId', { userId })
      .andWhere('calibration_axis_mean_x IS NULL')
      .execute();
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
       WHERE deactivated_at IS NULL
         AND ST_DWithin(
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
    return result[0]?.id ?? null;
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
    const curr = deviations[i];
    const prev = deviations[i - 1];
    if (curr === undefined || prev === undefined) continue;
    if ((curr - mean) * (prev - mean) < 0) {
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
