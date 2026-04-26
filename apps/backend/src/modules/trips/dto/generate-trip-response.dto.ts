import { ApiProperty } from '@nestjs/swagger';
import { TripDayDto, TripDetailDto } from './trip-response.dto.js';
import {
  TRIP_GENERATION_OPTIONS,
  type TripGenerationOptionId,
} from './generate-trip.dto.js';

/**
 * One alternative the generator produced. The `selected` option is the
 * one persisted to `trip_days` / `trip_waypoints` (and embedded in
 * `trip` on the parent response). The other two are returned only as
 * preview data so the UI can compare side-by-side without an extra
 * round-trip.
 */
export class TripGenerationOptionDto {
  @ApiProperty({ enum: TRIP_GENERATION_OPTIONS })
  id!: TripGenerationOptionId;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  summary!: string;

  @ApiProperty({ description: 'Sum of distance_km across days.' })
  total_distance_km!: number;

  @ApiProperty({ description: 'Sum of estimated_time_min across days.' })
  total_duration_min!: number;

  @ApiProperty({
    description: 'Mean of avg_quality across days, weighted by km.',
  })
  avg_quality!: number;

  @ApiProperty({
    description:
      'Mean of curviness_score across days, weighted by km. 0 = straight, 100 = very twisty.',
  })
  avg_curviness!: number;

  @ApiProperty({
    description:
      'Mean of scenic_score across days, weighted by km. 0..100, ' +
      'reflecting fun-zone proximity and curviness mix.',
  })
  avg_scenic!: number;

  @ApiProperty({
    description: 'Whether this is the option persisted on the trip.',
  })
  selected!: boolean;

  @ApiProperty({ type: [TripDayDto] })
  days!: TripDayDto[];
}

/**
 * Wraps the persisted `trip` (with the selected option already written to
 * `trip_days`/`trip_waypoints`) plus all three options for side-by-side
 * comparison in the companion's "compare options" view (US-34).
 */
export class GenerateTripResponseDto {
  @ApiProperty({ type: TripDetailDto })
  trip!: TripDetailDto;

  @ApiProperty({ enum: TRIP_GENERATION_OPTIONS })
  selected_option!: TripGenerationOptionId;

  @ApiProperty({ type: [TripGenerationOptionDto] })
  options!: TripGenerationOptionDto[];
}
