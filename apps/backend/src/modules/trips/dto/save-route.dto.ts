import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { LatLngDto, RouteOptionsDto } from '../../routing/dto/route.dto.js';

// Full waypoint type set accepted by the backend. Mirrors BUILT_WAYPOINT_TYPES
// in trips.service.ts so stops added by the rider (fuel, rest, photo,
// accommodation) survive a manual-route save.
const SAVE_ROUTE_WAYPOINT_TYPES = [
  'start',
  'via',
  'end',
  'fuel',
  'rest',
  'photo',
  'accommodation',
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
  @ApiProperty({ type: [SaveRouteWaypointDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => SaveRouteWaypointDto)
  waypoints!: SaveRouteWaypointDto[];

  @ApiProperty({ required: false, type: RouteOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouteOptionsDto)
  options?: RouteOptionsDto;
}
