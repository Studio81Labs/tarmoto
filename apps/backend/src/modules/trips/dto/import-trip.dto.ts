import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

const SOURCE_FORMATS = ['gpx', 'kml'] as const;

const WAYPOINT_TYPES = [
  'start',
  'via',
  'fuel',
  'rest',
  'photo',
  'end',
] as const;

/**
 * Hard caps on a single import. The geometry cap matches the per-file
 * point ceiling we apply to `/rides/import` so a malformed track can't
 * blow up the request body. 5,000 waypoints is far above what any real
 * GPX/KML emits — Garmin's planner tops out at ~125 — so flagging
 * higher numbers as 400 is harmless and protects the DB from a runaway
 * insert.
 */
export const IMPORT_TRIP_MAX_POINTS = 50_000;
export const IMPORT_TRIP_MAX_WAYPOINTS = 5_000;

class ImportTripPointDto {
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

class ImportTripWaypointDto extends ImportTripPointDto {
  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({ required: false, enum: WAYPOINT_TYPES })
  @IsOptional()
  @IsIn(WAYPOINT_TYPES as unknown as string[])
  type?: (typeof WAYPOINT_TYPES)[number];
}

/**
 * Body of `POST /trips/import`. The client (mobile or companion) parses
 * the GPX/KML file and posts the normalised result; the server creates
 * a 1-day trip with the supplied geometry and waypoints. We do not
 * re-run the route generator — the imported file IS the route.
 */
export class ImportTripDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  region?: string;

  @ApiProperty({ enum: SOURCE_FORMATS })
  @IsIn(SOURCE_FORMATS as unknown as string[])
  source_format!: (typeof SOURCE_FORMATS)[number];

  @ApiProperty({ type: [ImportTripPointDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(IMPORT_TRIP_MAX_POINTS)
  @ValidateNested({ each: true })
  @Type(() => ImportTripPointDto)
  geometry!: ImportTripPointDto[];

  @ApiProperty({ type: [ImportTripWaypointDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(IMPORT_TRIP_MAX_WAYPOINTS)
  @ValidateNested({ each: true })
  @Type(() => ImportTripWaypointDto)
  waypoints?: ImportTripWaypointDto[];
}
