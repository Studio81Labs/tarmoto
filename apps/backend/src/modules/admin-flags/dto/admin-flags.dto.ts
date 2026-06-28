import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const FEATURE_FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export class CreateFeatureFlagDto {
  @ApiProperty({
    description: 'Unique flag key (lowercase snake_case).',
    example: 'group_rides',
  })
  @IsString()
  @MaxLength(128)
  @Matches(FEATURE_FLAG_KEY_PATTERN, {
    message: 'key must be lowercase snake_case matching ^[a-z][a-z0-9_]*$',
  })
  key!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateFeatureFlagDto {
  @ApiPropertyOptional({ description: 'Toggle the flag.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class FeatureFlagDto {
  @ApiProperty() id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}
