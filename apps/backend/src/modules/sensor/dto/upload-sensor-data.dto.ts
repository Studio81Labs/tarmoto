import {
  IsUUID,
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsInt,
  IsIn,
  ValidateNested,
  ArrayMaxSize,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  MAX_TAG_EVENTS_PER_UPLOAD,
  SURFACE_LABELS,
  type SurfaceLabel,
} from '@tarmoto/shared';

export class SensorReadingDto {
  @ApiProperty({ description: 'Unix timestamp milliseconds' })
  @IsInt()
  t!: number;

  @ApiProperty({
    description:
      'Accelerometer X (m/s²). Pre-#493 clients send raw axes; ' +
      '#493+ clients send axes filtered by an on-device 22 Hz ' +
      'low-pass — see UploadSensorDataDto.client_preprocessing_version ' +
      'for the marker.',
  })
  @IsNumber()
  ax!: number;

  @ApiProperty({
    description:
      'Accelerometer Y (m/s²). Pre-#493 clients send raw axes; ' +
      '#493+ clients send axes filtered by an on-device 22 Hz low-pass.',
  })
  @IsNumber()
  ay!: number;

  @ApiProperty({
    description:
      'Accelerometer Z (m/s²). Pre-#493 clients send raw axes; ' +
      '#493+ clients send axes filtered by an on-device 22 Hz low-pass.',
  })
  @IsNumber()
  az!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  lat?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  lng?: number;

  @ApiProperty({ required: false, description: 'Speed in m/s' })
  @IsOptional()
  @IsNumber()
  speed?: number;

  /**
   * Estimated bike-frame roll (signed degrees) from the on-device
   * complementary filter (US-19). Optional — pre-calibration samples
   * carry no lean, and older clients don't compute it. Backend treats
   * an absent value as "unknown" and skips it from the per-ride
   * histogram so a quiet sensor doesn't pollute the distribution.
   */
  @ApiProperty({
    required: false,
    description:
      'Estimated bike-frame roll in degrees (signed). Absent when the ' +
      "client's orientation filter was still calibrating or the field " +
      "wasn't computed.",
  })
  @IsOptional()
  @IsNumber()
  lean_deg?: number;
}

export class RideTagEventDto {
  @ApiProperty({
    description: 'Unix timestamp milliseconds at the moment of the tap',
  })
  @IsInt()
  t!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  lat?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  lng?: number;

  @ApiProperty({
    enum: SURFACE_LABELS,
    description:
      'Rider-facing surface label. Backend normalises to ' +
      '(surface_type, quality_class) via SURFACE_LABEL_TO_TRUTH from ' +
      '@tarmoto/shared.',
  })
  @IsString()
  @IsIn(SURFACE_LABELS)
  label!: SurfaceLabel;
}

export class UploadSensorDataDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ride_id!: string;

  @ApiProperty({ required: false, example: 'iPhone 15 Pro' })
  @IsOptional()
  @IsString()
  device_model?: string;

  /**
   * Identifier of the on-device TF Lite classifier active when this
   * batch was uploaded (US-3). **Telemetry only** — the backend
   * re-derives `classification` and `surface_type` from the raw
   * readings, so this field describes the *client's* state, not how
   * the persisted labels were produced.
   *
   * Optional / absent when the mobile fallback heuristic ran (model
   * not bundled, load failed, or runtime error). Persisted on each
   * `surface_readings.client_model_version` so a future change that
   * trusts client window-level outputs can filter by classifier
   * version without backfilling.
   *
   * Constrained to `^[A-Za-z0-9._-]{1,32}$` so a malicious or buggy
   * client can't inject control characters into log lines or DB
   * indexes that key on the column.
   */
  @ApiProperty({
    required: false,
    example: 'rsc-v1.0.0',
    description:
      'Identifier of the client-side TF Lite classifier active when this ' +
      'batch was uploaded. Telemetry only — the backend always re-derives ' +
      'labels from raw readings, so this does NOT describe how the ' +
      'persisted classification was produced. Null/absent means the ' +
      'mobile fallback heuristic ran instead of the bundled model.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message:
      'client_model_version must be alphanumeric with optional ._- separators',
  })
  client_model_version?: string;

  /**
   * Identifier of the on-device preprocessing pipeline that produced
   * this batch's `ax/ay/az` (issue #493). The 22 Hz Butterworth
   * low-pass introduced by #493 changes the on-wire meaning of the
   * acceleration fields — pre-#493 clients send raw axes, #493+
   * clients send filtered axes. Carrying the marker on the upload
   * (and persisting it on each `surface_readings` row) lets training
   * exports and ML re-derivation filter or weight by preprocessing
   * regime without backfilling. Optional / absent means raw axes.
   *
   * Constrained to `^[A-Za-z0-9._-]{1,32}$` so a malicious or buggy
   * client can't inject control characters into log lines or DB
   * indexes that key on the column.
   */
  @ApiProperty({
    required: false,
    example: 'lp22-v1',
    description:
      'On-device preprocessing pipeline marker (issue #493). ' +
      '`lp22-v1` = 4th-order Butterworth low-pass at 22 Hz cutoff ' +
      'applied to ax/ay/az at sample ingest. Null/absent means raw ' +
      'axes (pre-#493 clients or a profile that disabled the filter).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message:
      'client_preprocessing_version must be alphanumeric with optional ._- separators',
  })
  client_preprocessing_version?: string;

  @ApiProperty({ type: [SensorReadingDto], maxItems: 5000 })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => SensorReadingDto)
  readings!: SensorReadingDto[];

  /**
   * Rider-asserted surface tags captured during the ride (research
   * issue #7). Optional — most rides will not run the tagging UI, and
   * the sensor pipeline must keep working when the array is absent.
   * The backend stores tags both verbatim (`ride_tag_events`) and as
   * a per-window join (`surface_readings.rider_*_label`) so future
   * training queries can read either resolution.
   */
  @ApiProperty({
    type: [RideTagEventDto],
    required: false,
    maxItems: MAX_TAG_EVENTS_PER_UPLOAD,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAG_EVENTS_PER_UPLOAD)
  @ValidateNested({ each: true })
  @Type(() => RideTagEventDto)
  tag_events?: RideTagEventDto[];
}
