import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  LatLngDto,
  MAX_ROUTE_WAYPOINTS,
  RouteOptionsDto,
} from '../../routing/dto/route.dto.js';

// Canonical waypoint type set accepted by the backend — must match
// TRIP_WAYPOINT_TYPES in trip-response.dto.ts so save and detail
// round-trip without loss. The companion maps its local types before
// posting (food/coffee instead of rest, hotel instead of accommodation).
const SAVE_ROUTE_WAYPOINT_TYPES = [
  'start',
  'via',
  'end',
  'fuel',
  'food',
  'coffee',
  'hotel',
  'photo',
] as const;
type SaveRouteWaypointType = (typeof SAVE_ROUTE_WAYPOINT_TYPES)[number];

export class SaveRouteWaypointDto extends LatLngDto {
  @ApiProperty({ required: false, nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;

  @ApiProperty({ enum: SAVE_ROUTE_WAYPOINT_TYPES })
  @IsIn(SAVE_ROUTE_WAYPOINT_TYPES)
  type!: SaveRouteWaypointType;
}

export class SaveRouteDto {
  @ApiProperty({
    type: [SaveRouteWaypointDto],
    minItems: 2,
    maxItems: MAX_ROUTE_WAYPOINTS,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_ROUTE_WAYPOINTS)
  @ValidateNested({ each: true })
  @Type(() => SaveRouteWaypointDto)
  waypoints!: SaveRouteWaypointDto[];

  @ApiProperty({ required: false, type: RouteOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouteOptionsDto)
  options?: RouteOptionsDto;
}
