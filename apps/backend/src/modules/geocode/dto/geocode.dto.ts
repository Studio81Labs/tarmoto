import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Cap on how many matches we surface — place-name search is rarely helped
 * by a long list, and a tight cap keeps the response small and predictable. */
export const MAX_GEOCODE_RESULTS = 5;

export class GeocodeQueryDto {
  @ApiProperty({
    description: 'Place name to geocode (e.g. "Tatra Mountains", "Brno").',
    minLength: 2,
    maxLength: 200,
  })
  // Trim before validation so `?q=%20%20` fails `@MinLength(2)` at the
  // DTO boundary instead of slipping through to the service layer.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @ApiProperty({
    required: false,
    default: MAX_GEOCODE_RESULTS,
    maximum: MAX_GEOCODE_RESULTS,
    minimum: 1,
    description: 'Max number of matches to return.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(MAX_GEOCODE_RESULTS)
  limit?: number;
}

export class GeocodeResultDto {
  @ApiProperty({
    description: 'Human-readable place label, suitable for a dropdown row.',
  })
  label!: string;

  @ApiProperty({ description: 'Latitude in decimal degrees, WGS84.' })
  lat!: number;

  @ApiProperty({ description: 'Longitude in decimal degrees, WGS84.' })
  lng!: number;

  @ApiProperty({
    description:
      'Provider-specific relevance score in [0, 1]. Higher is a better match.',
    minimum: 0,
    maximum: 1,
  })
  importance!: number;
}

export class GeocodeListDto {
  @ApiProperty({ type: [GeocodeResultDto] })
  results!: GeocodeResultDto[];
}
