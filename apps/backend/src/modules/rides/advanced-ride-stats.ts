import type { RideDetailDto, RideSummaryDto } from './dto/ride-response.dto.js';

/**
 * `advanced_ride_stats` (Pro) paywall. Returns a copy of a ride summary or
 * detail response with the ADVANCED stat fields nulled — lean angle(s)
 * (max + distribution + per segment) and the elevation profile — while
 * leaving the basic stats (distance, speed, quality, curviness, duration,
 * fuel, geometry) intact. Applied to the list + detail read paths for a
 * viewer who lacks the entitlement.
 *
 * `RideSummaryDto` (the list path) only carries `max_lean_angle` among the
 * advanced fields; `RideDetailDto` (the detail path) additionally carries
 * `lean_distribution`, `elevation_gain`, `elevation_loss`, and per-segment
 * `lean_angle_max`. Overloaded on the two shapes (rather than a single
 * `RideResponseDto` generic) so a stripped summary never gains detail-only
 * keys the OpenAPI schema doesn't declare for it. Non-mutating.
 */
export function stripAdvancedRideStats(dto: RideDetailDto): RideDetailDto;
export function stripAdvancedRideStats(dto: RideSummaryDto): RideSummaryDto;
export function stripAdvancedRideStats(
  dto: RideSummaryDto | RideDetailDto,
): RideSummaryDto | RideDetailDto {
  if (isRideDetailDto(dto)) {
    return {
      ...dto,
      max_lean_angle: null,
      lean_distribution: null,
      elevation_gain: null,
      elevation_loss: null,
      segments: dto.segments.map((segment) => ({
        ...segment,
        lean_angle_max: null,
      })),
    };
  }
  return { ...dto, max_lean_angle: null };
}

function isRideDetailDto(
  dto: RideSummaryDto | RideDetailDto,
): dto is RideDetailDto {
  return 'segments' in dto;
}
