import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class QueryBestRoadsDto {
  @ApiProperty({
    description: 'ISO 3166-1 alpha-2 country code, lowercased',
    example: 'cz',
  })
  @IsString()
  @Matches(/^[a-z]{2}$/)
  country!: string;

  @ApiProperty({
    description: 'Region slug (kebab-case)',
    example: 'beskydy',
  })
  @IsString()
  @Matches(/^[a-z0-9-]{1,60}$/)
  region!: string;

  @ApiProperty({
    description: 'Maximum roads to return',
    default: 10,
    required: false,
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
