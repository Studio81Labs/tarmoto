import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  IsOptional,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  buildManagedPhotoUrlValidator,
  isAllowedManagedPhotoUrl,
} from '../../../common/managed-photo-url.js';

export const MAX_REVIEW_PHOTOS = 5;
export const MAX_REVIEW_PHOTO_BYTES = 5 * 1024 * 1024;
export const REVIEW_PHOTO_PATH_PREFIX = '/uploads/road-review-photos/';

/**
 * Maps each accepted upload mimetype to the on-disk extension we'll use.
 * The set is intentionally narrow — we only accept image formats every
 * mainstream browser can render via plain `<img src>` so the gallery
 * doesn't need a per-format fallback path.
 */
export const ALLOWED_REVIEW_PHOTO_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

/**
 * Re-exported for callers that need the same protocol check on their
 * own DB-loaded values (e.g. `sanitizeReviewPhotos`). The underlying
 * rule lives in `common/managed-photo-url.ts` so review and hazard
 * photo surfaces stay in lockstep — see that module's comment for
 * the full https-vs-loopback rationale.
 */
export const isAllowedReviewPhotoUrl = isAllowedManagedPhotoUrl;

const IsReviewPhotoUrl = buildManagedPhotoUrlValidator('isReviewPhotoUrl');

/**
 * Coerce a raw photos value from the DB into the DTO contract: keep only
 * URLs that pass the same rule `CreateReviewDto.photos` enforces and cap
 * at `MAX_REVIEW_PHOTOS`. The `road_reviews.photos` column is `text[]`
 * with no per-element validation, and legacy rows may predate the rule;
 * both response mappers (`reviews.service.toResponse` and
 * `roads.service.mapReviewRows`) must go through this so /roads/:id and
 * /roads/:id/reviews can't disagree on what's valid.
 */
export function sanitizeReviewPhotos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw as unknown[]) {
    if (typeof p !== 'string') continue;
    // Trim before the protocol/host check so whitespace-padded strings
    // (e.g. "  https://ok.example.com/ok.jpg ") are kept in their cleaned
    // form — clients render the URL directly and a leading space would
    // break Image source.uri fetches.
    const candidate = p.trim();
    if (!isAllowedReviewPhotoUrl(candidate)) continue;
    out.push(candidate);
    if (out.length >= MAX_REVIEW_PHOTOS) break;
  }
  return out;
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
    description:
      'URLs of review photos hosted on Tarmoto media storage. Use ' +
      'POST /roads/:segmentId/reviews/photos to obtain these URLs.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REVIEW_PHOTOS)
  @IsReviewPhotoUrl({ each: true })
  photos?: string[];
}

export class ReviewPhotosResponseDto {
  @ApiProperty({
    type: [String],
    maxItems: MAX_REVIEW_PHOTOS,
    description:
      'URLs of the photos that were just uploaded. Submit these as the ' +
      '`photos` field on POST/PUT /roads/:segmentId/reviews to attach ' +
      'them to a review.',
  })
  photos!: string[];
}

export class ReviewResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    nullable: true,
    description:
      'Author user id, used by clients to deep-link to the rider profile. ' +
      '`null` when the author has been soft-deleted (matches the masked ' +
      '`user_display_name`), so the client should not render a profile link.',
  })
  user_id!: string | null;

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

  @ApiProperty({ description: 'Count of helpful votes from other riders' })
  helpful_count!: number;

  @ApiProperty({ description: 'Count of not-helpful votes from other riders' })
  not_helpful_count!: number;

  @ApiProperty({
    nullable: true,
    description:
      'The caller’s own vote: true = helpful, false = not helpful, ' +
      'null when the caller has not voted or is anonymous.',
  })
  my_vote!: boolean | null;

  @ApiProperty({
    description:
      'True when this review belongs to the authenticated caller, else false.',
  })
  is_mine!: boolean;
}

export class ReviewVoteDto {
  @ApiProperty({
    description:
      'true for a helpful vote, false for not-helpful. Resubmitting with ' +
      'the opposite value flips the caller’s vote in place.',
  })
  @IsBoolean()
  is_helpful!: boolean;
}

export class ReviewVoteResultDto {
  @ApiProperty()
  helpful_count!: number;

  @ApiProperty()
  not_helpful_count!: number;

  @ApiProperty({ nullable: true })
  my_vote!: boolean | null;
}
