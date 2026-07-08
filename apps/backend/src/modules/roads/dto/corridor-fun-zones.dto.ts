import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const DEFAULT_FUN_ZONE_CORRIDOR_KM = 2;
// Matches the passes `check-route` reach (20 km) + the STOPS-tab's widest
// corridor option, so the `twisty_highlight` layer works across all of them.
export const MAX_FUN_ZONE_CORRIDOR_KM = 20;

/**
 * Vertex cap — bounds the `ST_MakeLine` + bind-param array independently of the
 * body limit (mirrors `route-quality`'s `MAX_ROUTE_QUALITY_POINTS`). A dense
 * multi-day polyline stays well under this.
 */
export const MAX_FUN_ZONE_CORRIDOR_POINTS = 25000;

/**
 * One point of the routed polyline (request side). Mirrors the passes /
 * route-quality point DTOs — validated lat/lng so a malformed body is rejected
 * at the DTO boundary before it reaches the spatial query.
 */
class CorridorFunZonePointDto {
  @ApiProperty()
  @IsLatitude()
  @Type(() => Number)
  lat!: number;

  @ApiProperty()
  @IsLongitude()
  @Type(() => Number)
  lng!: number;
}

/**
 * `POST /roads/fun-zones/in-corridor` — Fun Zones whose boundary falls within
 * `buffer_km` of a routed polyline (#865, the STOPS-tab `twisty_highlight`
 * layer). Mirrors `POST /poi/in-corridor`: a route body + a km half-width,
 * filtered with a geography `ST_DWithin` over the zone polygon.
 */
export class CorridorFunZonesDto {
  @ApiProperty({
    type: [CorridorFunZonePointDto],
    minItems: 2,
    maxItems: MAX_FUN_ZONE_CORRIDOR_POINTS,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_FUN_ZONE_CORRIDOR_POINTS)
  @ValidateNested({ each: true })
  @Type(() => CorridorFunZonePointDto)
  route!: CorridorFunZonePointDto[];

  @ApiPropertyOptional({
    minimum: 0.5,
    maximum: MAX_FUN_ZONE_CORRIDOR_KM,
    // No `default:` on purpose — openapi-typescript emits a defaulted optional
    // as *required*, forcing every caller to send it. The default is applied
    // server-side (`dto.buffer_km ?? DEFAULT_FUN_ZONE_CORRIDOR_KM`).
    description:
      `Corridor half-width in km (default ${DEFAULT_FUN_ZONE_CORRIDOR_KM}, ` +
      `capped at ${MAX_FUN_ZONE_CORRIDOR_KM}). Applied server-side.`,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0.5)
  @Max(MAX_FUN_ZONE_CORRIDOR_KM)
  buffer_km?: number;
}
