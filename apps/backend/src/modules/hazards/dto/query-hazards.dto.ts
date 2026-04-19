import {
  IsNumber,
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class QueryHazardsDto {
  @ApiProperty({ example: 49.1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lat!: number;

  @ApiProperty({ example: 16.75 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  lng!: number;

  @ApiProperty({ default: 10000, required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(100)
  @Max(50000)
  radius?: number;

  @ApiProperty({
    required: false,
    description: 'Comma-separated hazard types',
    example: 'pothole,gravel,roadworks',
  })
  @IsOptional()
  @IsString()
  types?: string;
}
