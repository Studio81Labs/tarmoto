import { IsInt, IsOptional, IsEnum, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class TileParamsDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(22)
  z!: number;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  x!: number;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  y!: number;
}

const TILE_LAYERS = ['quality', 'surface', 'hazards', 'all'] as const;

export class TileQueryDto {
  @ApiProperty({
    enum: TILE_LAYERS,
    default: 'all',
    required: false,
  })
  @IsOptional()
  @IsEnum(TILE_LAYERS)
  layers?: (typeof TILE_LAYERS)[number];
}
