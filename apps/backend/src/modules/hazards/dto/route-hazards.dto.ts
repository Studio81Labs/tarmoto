import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class LatLng {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}

export class RouteHazardsDto {
  @ApiProperty({ type: [LatLng], minItems: 2 })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LatLng)
  route: LatLng[];

  @ApiProperty({ default: 200, required: false })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(1000)
  buffer_m?: number;
}
