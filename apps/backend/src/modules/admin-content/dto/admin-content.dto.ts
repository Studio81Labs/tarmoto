import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ContentType } from '../content-types.js';

export const CONTENT_STATUS_FILTERS = ['visible', 'hidden', 'all'] as const;
export type ContentStatusFilter = (typeof CONTENT_STATUS_FILTERS)[number];

export class ListContentQueryDto {
  @ApiProperty({ enum: ContentType, description: 'Content type to browse.' })
  @IsEnum(ContentType)
  type!: ContentType;

  @ApiPropertyOptional({
    enum: CONTENT_STATUS_FILTERS,
    description: 'Filter by moderation status. Defaults to all.',
  })
  @IsOptional()
  @IsIn(CONTENT_STATUS_FILTERS)
  status?: ContentStatusFilter;

  @ApiPropertyOptional({ description: 'Substring match on the content text.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class HideContentDto {
  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class ContentLocationDto {
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
}

export class ContentItemDto {
  @ApiProperty({ enum: ContentType }) type!: ContentType;
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) authorId!: string | null;
  @ApiProperty({ nullable: true }) authorName!: string | null;
  @ApiProperty({ nullable: true }) text!: string | null;
  @ApiProperty({ type: [String] }) photoUrls!: string[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true }) moderationReason!: string | null;
  @ApiProperty({ nullable: true }) moderatedAt!: string | null;
  @ApiProperty({ type: ContentLocationDto, nullable: true })
  location!: ContentLocationDto | null;
}

export class ContentListResponseDto {
  @ApiProperty({ type: [ContentItemDto] }) rows!: ContentItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
