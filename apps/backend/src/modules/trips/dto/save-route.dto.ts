import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { LatLngDto, RouteOptionsDto } from '../../routing/dto/route.dto.js';

export class SaveRouteWaypointDto extends LatLngDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiProperty({ enum: ['start', 'via', 'end'] })
  @IsIn(['start', 'via', 'end'])
  type!: 'start' | 'via' | 'end';
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
