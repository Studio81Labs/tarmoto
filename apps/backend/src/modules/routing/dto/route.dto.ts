import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class LatLngDto {
  @ApiProperty() @IsNumber() lat!: number;
  @ApiProperty() @IsNumber() lng!: number;
}

export class RouteOptionsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  avoid_highways?: boolean;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  avoid_tolls?: boolean;
  @ApiProperty({
    required: false,
    description:
      'Reserved — accepted but not yet applied to live routing (phase 1).',
  })
  @IsOptional()
  @IsBoolean()
  avoid_unpaved?: boolean;
  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Reserved — accepted but not yet applied to live routing (phase 1).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  surfaces?: string[];
}

export class RouteRequestDto {
  @ApiProperty({ type: [LatLngDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => LatLngDto)
  waypoints!: LatLngDto[];

  @ApiProperty({ required: false, type: RouteOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouteOptionsDto)
  options?: RouteOptionsDto;
}

export class RouteResponseDto {
  @ApiProperty({ type: [LatLngDto] }) geometry!: LatLngDto[];
  @ApiProperty() distance_km!: number;
  @ApiProperty() duration_min!: number;
  @ApiProperty({ nullable: true }) avg_quality!: number | null;
  @ApiProperty({ nullable: true }) curviness_score!: number | null;
  @ApiProperty() elevation_gain_m!: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  surface_mix!: Record<string, number>;
}
