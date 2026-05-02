import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  resolveManagedPhoto,
  type ManagedPhoto,
} from '../../common/managed-photo-url.js';
import { buildTrustedManagedOriginCheck } from '../../common/trusted-managed-origin.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadReviewVote } from '../../entities/road-review-vote.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import {
  ALLOWED_REVIEW_PHOTO_TYPES,
  CreateReviewDto,
  MAX_REVIEW_PHOTOS,
  REVIEW_PHOTO_PATH_PREFIX,
  ReviewPhotosResponseDto,
  ReviewResponseDto,
  ReviewVoteResultDto,
  sanitizeReviewPhotos,
} from './dto/review.dto.js';

const REVIEW_PHOTO_UPLOAD_DIR = join(
  process.cwd(),
  'uploads',
  'road-review-photos',
);

/**
 * Resolve a review photo URL to its managed filename + on-disk path
 * inside the review-photos upload directory, or `null` when the URL
 * is not one we own. Thin wrapper around the shared
 * `resolveManagedPhoto` so the path-traversal guard stays
 * single-sourced — see that helper's comment for the full
 * separator/control-char/dot-segment rationale.
 */
function resolveManagedReviewPhoto(
  photoUrl: string | null,
  isTrustedOrigin: (parsed: URL) => boolean,
): ManagedPhoto | null {
  return resolveManagedPhoto(photoUrl, {
    pathPrefix: REVIEW_PHOTO_PATH_PREFIX,
    uploadDir: REVIEW_PHOTO_UPLOAD_DIR,
    isTrustedOrigin,
  });
}

/**
 * Build the prefix every managed filename uploaded by `(segmentId, userId)`
 * starts with — `<segmentId>-<userId>-`. Both ids are UUIDs in production
 * (the controller's `ParseUUIDPipe` enforces it), so a `startsWith` check
 * unambiguously identifies ownership: a managed file `X` was uploaded by
 * `userId` for `segmentId` iff `filename.startsWith(buildOwnedPrefix(...))`.
 */
function buildOwnedPrefix(segmentId: string, userId: string): string {
  return `${segmentId}-${userId}-`;
}

function isOwnedManagedPhoto(
  photo: ManagedPhoto,
  segmentId: string,
  userId: string,
): boolean {
  return photo.filename.startsWith(buildOwnedPrefix(segmentId, userId));
}

/**
 * Reject a `photos[]` payload that references a managed file the caller
 * doesn't own.
 *
 * `CreateReviewDto.photos` only validates URL shape, not authorization,
 * so without this check user B could attach user A's
 * `/uploads/road-review-photos/...` URL to B's own review — and then a
 * later `delete`/`update` on B's review would unlink the shared file out
 * from under A. Forcing every managed URL to carry the caller's
 * `<segmentId>-<userId>-` filename prefix means cascade deletes only ever
 * touch files the same user produced for the same segment.
 *
 * Third-party URLs that don't resolve to a managed path pass through
 * untouched — we never wrote those, so we can't and won't delete them.
 */
function assertReviewPhotosAreOwned(
  photoUrls: readonly string[] | null | undefined,
  segmentId: string,
  userId: string,
  isTrustedOrigin: (parsed: URL) => boolean,
): void {
  if (!photoUrls?.length) return;
  for (const photoUrl of photoUrls) {
    const managed = resolveManagedReviewPhoto(photoUrl, isTrustedOrigin);
    if (!managed) continue;
    if (!isOwnedManagedPhoto(managed, segmentId, userId)) {
      throw new BadRequestException(
        'Photo URL refers to a file you did not upload for this segment',
      );
    }
  }
}

/**
 * Trim every entry in a photo URL list and drop empties, mirroring what
 * `sanitizeReviewPhotos` returns on the response side. Both ends of the
 * cascade-delete diff (and what we save to the DB) need to go through
 * this — otherwise a stored ` https://.../x.jpg ` and an updated
 * `https://.../x.jpg` look different to a `Set` and the still-referenced
 * file gets unlinked. `IsReviewPhotoUrl` already validates `value.trim()`,
 * so any padding that passes validation has no semantic meaning anyway.
 */
function normalizeReviewPhotoList(
  photoUrls: readonly string[] | null | undefined,
): string[] {
  if (!photoUrls?.length) return [];
  const out: string[] = [];
  for (const photoUrl of photoUrls) {
    if (typeof photoUrl !== 'string') continue;
    const trimmed = photoUrl.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Best-effort delete of managed review-photo files the caller owns, out of
 * the given URL list. Third-party URLs, missing files, and managed files
 * uploaded by another user are skipped silently — the caller has already
 * committed the new state in the DB and we don't want a stray orphan to
 * surface a 500, and we never delete a file we don't own. Permission
 * errors still bubble so an operator notices a misconfigured uploads
 * directory.
 */
async function deleteOwnedReviewPhotos(
  photoUrls: readonly string[] | null | undefined,
  segmentId: string,
  userId: string,
  isTrustedOrigin: (parsed: URL) => boolean,
): Promise<void> {
  if (!photoUrls?.length) return;
  for (const photoUrl of photoUrls) {
    const managed = resolveManagedReviewPhoto(photoUrl, isTrustedOrigin);
    if (!managed) continue;
    // Defense in depth: even if `assertReviewPhotosAreOwned` was bypassed
    // (e.g. a legacy row predating the ownership rule), the cascade-delete
    // refuses to touch files outside the caller's `<segmentId>-<userId>-`
    // namespace so removing review B can't break review A.
    if (!isOwnedManagedPhoto(managed, segmentId, userId)) continue;
    try {
      await unlink(managed.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

interface VoteAggregate {
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
}

@Injectable()
export class ReviewsService {
  // Built once at construction so each create / update / delete doesn't
  // re-read TARMOTO_PUBLIC_BASE_URL. Closes the loophole where a third-
  // party URL with our managed pathname prefix would be mis-classified
  // as a managed photo (see `buildTrustedManagedOriginCheck`).
  private readonly isTrustedManagedOrigin: (parsed: URL) => boolean;

  constructor(
    @InjectRepository(RoadReview)
    private readonly reviewRepo: Repository<RoadReview>,
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
    @InjectRepository(RoadReviewVote)
    private readonly voteRepo: Repository<RoadReviewVote>,
    config: ConfigService,
  ) {
    this.isTrustedManagedOrigin = buildTrustedManagedOriginCheck(config);
  }

  async listForSegment(
    segmentId: string,
    viewerUserId: string | null = null,
  ): Promise<ReviewResponseDto[]> {
    const reviews = await this.reviewRepo.find({
      where: { road_segment_id: segmentId },
      relations: ['user'],
      order: { created_at: 'DESC' },
    });
    const voteMap = await this.aggregateVotes(
      reviews.map((r) => r.id),
      viewerUserId,
    );
    return reviews.map((r) =>
      this.toResponse(r, voteMap.get(r.id), viewerUserId),
    );
  }

  async create(
    userId: string,
    segmentId: string,
    dto: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    // Verify segment exists
    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId },
    });
    if (!segment) {
      throw new NotFoundException('Road segment not found');
    }

    // Normalize before any further processing — `IsReviewPhotoUrl`
    // accepts whitespace-padded URLs (it validates `value.trim()`), and
    // we want what's saved to match what the response sanitizer returns
    // so update / cascade-delete diffs don't drift on padding alone.
    const normalizedPhotos = normalizeReviewPhotoList(dto.photos);

    // Block attaching managed photos that another user uploaded — see
    // `assertReviewPhotosAreOwned` for why DTO-level URL validation isn't
    // enough on its own.
    assertReviewPhotosAreOwned(
      normalizedPhotos,
      segmentId,
      userId,
      this.isTrustedManagedOrigin,
    );

    const review = this.reviewRepo.create({
      user_id: userId,
      road_segment_id: segmentId,
      rating: dto.rating,
      comment: dto.comment ?? null,
      bike_model: dto.bike_model ?? null,
      photos: normalizedPhotos.length > 0 ? normalizedPhotos : null,
    });

    let saved: RoadReview;
    try {
      saved = await this.reviewRepo.save(review);
    } catch (err: unknown) {
      // Unique constraint: one review per user per segment
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new ConflictException(
          'You have already reviewed this road segment',
        );
      }
      throw err;
    }

    // Reload with user relation for response
    const full = await this.reviewRepo.findOne({
      where: { id: saved.id },
      relations: ['user'],
    });

    // Freshly created reviews have no votes yet.
    return this.toResponse(
      full!,
      {
        helpful_count: 0,
        not_helpful_count: 0,
        my_vote: null,
      },
      userId,
    );
  }

  async update(
    userId: string,
    segmentId: string,
    dto: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    const review = await this.reviewRepo.findOne({
      where: { user_id: userId, road_segment_id: segmentId },
      relations: ['user'],
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    // Normalize incoming and stored URLs to the same trimmed form so the
    // set-difference below can't mistake padding for an actual removal —
    // a row stored as ` https://.../x.jpg ` (legacy / direct API) and an
    // update sending `https://.../x.jpg` are the same photo.
    const previousPhotos = normalizeReviewPhotoList(review.photos);
    const nextPhotos = normalizeReviewPhotoList(dto.photos);

    // Block attaching managed photos uploaded by someone else (see
    // `assertReviewPhotosAreOwned`).
    assertReviewPhotosAreOwned(
      nextPhotos,
      segmentId,
      userId,
      this.isTrustedManagedOrigin,
    );

    review.rating = dto.rating;
    review.comment = dto.comment ?? null;
    review.bike_model = dto.bike_model ?? null;
    review.photos = nextPhotos.length > 0 ? nextPhotos : null;

    const saved = await this.reviewRepo.save(review);

    // Cascade-delete files for any managed photos that the new payload
    // dropped, so removing a photo from an existing review doesn't leave
    // an orphan on disk. Run after save so a DB failure can't leave the
    // row pointing at a file we already deleted. The ownership filter
    // inside `deleteOwnedReviewPhotos` ensures we never delete a file
    // another user uploaded — even if a legacy row carries a foreign URL.
    const nextSet = new Set(nextPhotos);
    const removed = previousPhotos.filter((photo) => !nextSet.has(photo));
    await deleteOwnedReviewPhotos(
      removed,
      segmentId,
      userId,
      this.isTrustedManagedOrigin,
    );

    const voteMap = await this.aggregateVotes([saved.id], userId);
    return this.toResponse(saved, voteMap.get(saved.id), userId);
  }

  async delete(userId: string, segmentId: string): Promise<void> {
    const review = await this.reviewRepo.findOne({
      where: { user_id: userId, road_segment_id: segmentId },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    // Normalize so a legacy padded URL still resolves to the same managed
    // file the path-resolver would otherwise miss.
    const photos = normalizeReviewPhotoList(review.photos);
    await this.reviewRepo.remove(review);
    await deleteOwnedReviewPhotos(
      photos,
      segmentId,
      userId,
      this.isTrustedManagedOrigin,
    );
  }

  /**
   * Persist uploaded review photo files to local disk and return the URLs
   * the caller should submit on the next `POST/PUT /roads/:id/reviews`.
   *
   * The endpoint deliberately doesn't require the review to exist yet —
   * the typical flow is upload-then-create, and validating the segment
   * here would force a second roundtrip. Orphaned files (uploaded then
   * never attached) are accepted as a known cost; an S3-backed lifecycle
   * sweep is tracked separately. We do still verify the segment exists so
   * arbitrary UUIDs can't be used to spam the uploads directory.
   */
  async uploadPhotos(
    userId: string,
    segmentId: string,
    files: Express.Multer.File[],
    publicBaseUrl: string,
  ): Promise<ReviewPhotosResponseDto> {
    if (files.length === 0) {
      throw new BadRequestException('At least one photo file is required');
    }
    if (files.length > MAX_REVIEW_PHOTOS) {
      throw new BadRequestException(
        `You can upload up to ${MAX_REVIEW_PHOTOS} photos at a time`,
      );
    }

    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId },
    });
    if (!segment) {
      throw new NotFoundException('Road segment not found');
    }

    const records = files.map((file) => {
      const extension = ALLOWED_REVIEW_PHOTO_TYPES.get(file.mimetype);
      if (!extension) {
        throw new BadRequestException(
          'Photos must be PNG, JPEG, or WebP images',
        );
      }
      const filename = `${segmentId}-${userId}-${Date.now()}-${randomUUID()}${extension}`;
      return { file, filename };
    });

    await mkdir(REVIEW_PHOTO_UPLOAD_DIR, { recursive: true });

    const written: string[] = [];
    try {
      for (const { file, filename } of records) {
        const filePath = join(REVIEW_PHOTO_UPLOAD_DIR, filename);
        await writeFile(filePath, file.buffer);
        written.push(filename);
      }
    } catch (error) {
      // Roll back any partial writes (e.g. ENOSPC mid-batch) so the caller
      // either gets every URL it expected or none — half-uploaded galleries
      // would leak storage and confuse retry logic on the client.
      for (const filename of written) {
        await unlink(join(REVIEW_PHOTO_UPLOAD_DIR, filename)).catch(() => {});
      }
      throw error;
    }

    return {
      photos: written.map(
        (filename) => `${publicBaseUrl}${REVIEW_PHOTO_PATH_PREFIX}${filename}`,
      ),
    };
  }

  /**
   * Cast or flip a helpful vote. The unique (user_id, review_id) constraint
   * keeps this to at most one row per caller-review pair; the upsert here
   * means pressing "helpful" after "not helpful" just updates the existing
   * row, which is what the mobile / web UIs expect.
   *
   * A rider cannot vote on their own review — allowing that would let the
   * author pad their own helpful count and the backend is the right place
   * to enforce it (the UI hides the buttons, but that's cosmetic).
   */
  async castVote(
    userId: string,
    reviewId: string,
    isHelpful: boolean,
  ): Promise<ReviewVoteResultDto> {
    const review = await this.reviewRepo.findOne({
      where: { id: reviewId },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    if (review.user_id === userId) {
      throw new ConflictException('Cannot vote on your own review');
    }

    await this.voteRepo
      .createQueryBuilder()
      .insert()
      .into(RoadReviewVote)
      .values({
        user_id: userId,
        road_review_id: reviewId,
        is_helpful: isHelpful,
      })
      .orUpdate(['is_helpful', 'updated_at'], ['user_id', 'road_review_id'])
      .execute();

    const voteMap = await this.aggregateVotes([reviewId], userId);
    const agg = voteMap.get(reviewId) ?? {
      helpful_count: 0,
      not_helpful_count: 0,
      my_vote: null,
    };
    return {
      helpful_count: agg.helpful_count,
      not_helpful_count: agg.not_helpful_count,
      my_vote: agg.my_vote,
    };
  }

  async clearVote(
    userId: string,
    reviewId: string,
  ): Promise<ReviewVoteResultDto> {
    const review = await this.reviewRepo.findOne({
      where: { id: reviewId },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    await this.voteRepo.delete({
      user_id: userId,
      road_review_id: reviewId,
    });
    const voteMap = await this.aggregateVotes([reviewId], userId);
    const agg = voteMap.get(reviewId) ?? {
      helpful_count: 0,
      not_helpful_count: 0,
      my_vote: null,
    };
    return {
      helpful_count: agg.helpful_count,
      not_helpful_count: agg.not_helpful_count,
      my_vote: agg.my_vote,
    };
  }

  /**
   * Aggregate helpful / not-helpful counts for a batch of review ids and
   * (optionally) fetch the viewer's own vote for each. Returns a Map so
   * the caller can cheaply look up per-review results when zipping
   * response rows.
   */
  private async aggregateVotes(
    reviewIds: string[],
    viewerUserId: string | null,
  ): Promise<Map<string, VoteAggregate>> {
    const map = new Map<string, VoteAggregate>();
    if (reviewIds.length === 0) return map;

    // Seed every requested id with zeros so the caller can trust `.get(id)`
    // to always return an aggregate (no undefined handling downstream).
    for (const id of reviewIds) {
      map.set(id, {
        helpful_count: 0,
        not_helpful_count: 0,
        my_vote: null,
      });
    }

    const rows = await this.voteRepo
      .createQueryBuilder('v')
      .select('v.road_review_id', 'road_review_id')
      .addSelect(
        'COUNT(*) FILTER (WHERE v.is_helpful = true)::int',
        'helpful_count',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE v.is_helpful = false)::int',
        'not_helpful_count',
      )
      .where('v.road_review_id IN (:...ids)', { ids: reviewIds })
      .groupBy('v.road_review_id')
      .getRawMany<{
        road_review_id: string;
        helpful_count: number;
        not_helpful_count: number;
      }>();

    for (const row of rows) {
      map.set(row.road_review_id, {
        helpful_count: row.helpful_count,
        not_helpful_count: row.not_helpful_count,
        my_vote: null,
      });
    }

    if (viewerUserId) {
      const viewerVotes = await this.voteRepo.find({
        where: {
          user_id: viewerUserId,
          road_review_id: In(reviewIds),
        },
        select: ['road_review_id', 'is_helpful'],
      });
      for (const vote of viewerVotes) {
        const entry = map.get(vote.road_review_id);
        if (entry) entry.my_vote = vote.is_helpful;
      }
    }

    return map;
  }

  private toResponse(
    review: RoadReview,
    votes?: VoteAggregate,
    viewerUserId: string | null = null,
  ): ReviewResponseDto {
    // Soft-deleted authors are masked in feeds/profiles per GDPR
    // requirements (US-62) — the review row stays so historical
    // road-quality context is preserved, but the personal name is
    // hidden until the hard-delete sweep finishes the cascade.
    const authorVisible = review.user != null && review.user.deleted_at == null;
    return {
      id: review.id,
      user_display_name: authorVisible
        ? review.user.display_name
        : 'Deleted user',
      rating: review.rating,
      comment: review.comment,
      bike_model: review.bike_model,
      photos: sanitizeReviewPhotos(review.photos),
      created_at: review.created_at.toISOString(),
      helpful_count: votes?.helpful_count ?? 0,
      not_helpful_count: votes?.not_helpful_count ?? 0,
      my_vote: votes?.my_vote ?? null,
      is_mine:
        review.user_id === undefined || viewerUserId === null
          ? false
          : review.user_id === viewerUserId,
    };
  }
}
