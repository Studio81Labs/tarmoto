import { ApiProperty } from '@nestjs/swagger';

/**
 * One slice of a distance-weighted breakdown (surface type or curviness band).
 * The backend owns stable bucket keys and ordering; clients own localized
 * display labels for those keys.
 */
export class RideBreakdownSliceDto {
  @ApiProperty({
    description: 'Stable bucket key, e.g. "asphalt" or "twisty".',
  })
  key!: string;

  @ApiProperty({ description: 'Distance ridden in this bucket, in metres.' })
  meters!: number;

  @ApiProperty({
    description: 'Share of the total snapped distance, 0–100 (one decimal).',
  })
  pct!: number;
}

/**
 * Surface + curviness breakdown for a filtered set of rides, derived live from
 * the rides' snapped `ride_segments → road_segments` and weighted by segment
 * length (`length_m`). Both arrays are empty when no segments are snapped yet
 * (`total_meters === 0`) so the client can show an honest "no data" state
 * rather than a misleading all-zero chart.
 */
export class RideBreakdownDto {
  @ApiProperty({
    type: [RideBreakdownSliceDto],
    description:
      'Distance by road surface type, canonical order, surfaces with no ' +
      'distance omitted.',
  })
  surface!: RideBreakdownSliceDto[];

  @ApiProperty({
    type: [RideBreakdownSliceDto],
    description:
      'Distance by curviness band (straight → hairpin); the full ladder is ' +
      'returned so empty bands still render.',
  })
  curviness!: RideBreakdownSliceDto[];

  @ApiProperty({
    description:
      'Total snapped distance (metres) across the filtered rides. 0 when no ' +
      'segments are linked yet.',
  })
  total_meters!: number;
}
