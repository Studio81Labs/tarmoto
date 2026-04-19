import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  IsOptional,
  IsUrl,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const MAX_REVIEW_PHOTOS = 5;

/**
 * Coerce a raw photos value from the DB into the DTO contract: keep only
 * plain `https://` strings and cap at `MAX_REVIEW_PHOTOS`. The
 * `road_reviews.photos` column is `text[]` with no per-element validation,
 * and legacy rows may predate the HTTPS-only `CreateReviewDto` rule; both
 * response mappers (`reviews.service.toResponse` and
 * `roads.service.mapReviewRows`) must go through this so /roads/:id and
 * /roads/:id/reviews can't disagree on what's valid.
 */
export function sanitizeReviewPhotos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter(
      (p): p is string => typeof p === 'string' && p.startsWith('https://'),
    )
    .slice(0, MAX_REVIEW_PHOTOS);
}

export class CreateReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @ApiProperty({ required: false, example: 'BMW R1250GS' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bike_model?: string;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: MAX_REVIEW_PHOTOS,
    description: 'HTTPS URLs of review photos hosted on Tarmoto media storage.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REVIEW_PHOTOS)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  photos?: string[];
}

export class ReviewResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  user_display_name!: string;

  @ApiProperty()
  rating!: number;

  @ApiProperty({ nullable: true })
  comment!: string | null;

  @ApiProperty({ nullable: true })
  bike_model!: string | null;

  @ApiProperty({ type: [String] })
  photos!: string[];

  @ApiProperty()
  created_at!: string;
}
