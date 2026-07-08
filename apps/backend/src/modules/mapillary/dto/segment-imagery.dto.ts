import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class SegmentImageryQueryDto {
  @ApiProperty({ description: 'Latitude (WGS84).', minimum: -90, maximum: 90 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({
    description: 'Longitude (WGS84).',
    minimum: -180,
    maximum: 180,
  })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiProperty({
    required: false,
    description:
      'Travel heading in degrees (0 = N) — prefers an image facing this way.',
    minimum: 0,
    maximum: 360,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : Number(value),
  )
  @IsNumber()
  @Min(0)
  @Max(360)
  bearing?: number;
}

export class SegmentImageryDto {
  @ApiProperty({
    nullable: true,
    description: 'Street-level image URL, or null when there is no coverage.',
  })
  imageUrl!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'ISO date the image was captured (e.g. "2024-09-15").',
  })
  capturedAt!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Required credit line — Mapillary imagery is CC-BY-SA.',
  })
  attribution!: string | null;
}
