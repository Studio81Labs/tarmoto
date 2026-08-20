import {
  IsInt,
  IsOptional,
  IsEnum,
  IsString,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class TileParamsDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(22)
  z!: number;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  x!: number;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  y!: number;
}

const TILE_LAYERS = ['quality', 'surface', 'hazards', 'all'] as const;

export class TileQueryDto {
  @ApiProperty({
    enum: TILE_LAYERS,
    default: 'all',
    required: false,
  })
  @IsOptional()
  @IsEnum(TILE_LAYERS)
  layers?: (typeof TILE_LAYERS)[number];

  @ApiProperty({
    required: false,
    description:
      'Scoped tile credential from POST /roads/tiles/token (#1279). Lets a ' +
      'MapLibre source resolve `road_quality_max_zoom` against the rider ' +
      'instead of the anonymous free tier. Absent, expired or invalid = the ' +
      'request is served anonymously; it is never an error, so a stale ' +
      'credential degrades the map to the free view instead of breaking it.',
  })
  @IsOptional()
  @IsString()
  // A tile token is a compact HS256 JWT (~200 chars). The bound is not a
  // security control — the signature is — it just stops an attacker making the
  // server verify megabyte-long strings, and keeps the 400 for a truncated
  // token cheap.
  @MaxLength(1024)
  tile_token?: string;
}
