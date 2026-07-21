import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export const DEFAULT_FUN_ZONE_BBOX_RESULTS = 50;
export const MAX_FUN_ZONE_BBOX_RESULTS = 100;
export const MAX_FUN_ZONE_BBOX_AREA_DEG2 = 400;

export class QueryFunZonesDto {
  @ApiProperty({
    description: 'Bounding box: west,south,east,north',
    example: '18.1,49.4,18.6,49.7',
  })
  @IsString()
  bbox!: string;

  @ApiPropertyOptional({
    default: DEFAULT_FUN_ZONE_BBOX_RESULTS,
    minimum: 1,
    maximum: MAX_FUN_ZONE_BBOX_RESULTS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_FUN_ZONE_BBOX_RESULTS)
  limit?: number;
}
