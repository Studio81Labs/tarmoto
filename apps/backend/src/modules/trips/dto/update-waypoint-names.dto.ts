import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// A trip holds at most MAX_ROUTE_WAYPOINTS (50) per day across MAX_TRIP_DAYS
// (14) — so 700 is the theoretical ceiling for a whole-trip rename batch.
const MAX_WAYPOINT_RENAMES = 700;

export class WaypointNameDto {
  @ApiProperty({ format: 'uuid', description: 'Waypoint to rename.' })
  @IsUUID()
  id!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    maxLength: 200,
    description:
      'New display name; null clears it back to the default label. Same ' +
      'length bound as the save-route waypoint name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;
}

export class UpdateWaypointNamesDto {
  @ApiProperty({
    type: [WaypointNameDto],
    minItems: 1,
    maxItems: MAX_WAYPOINT_RENAMES,
    description:
      'Waypoints to rename, matched by id and scoped to the trip. Ids not ' +
      'belonging to the trip are ignored.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WAYPOINT_RENAMES)
  @ValidateNested({ each: true })
  @Type(() => WaypointNameDto)
  waypoints!: WaypointNameDto[];
}
