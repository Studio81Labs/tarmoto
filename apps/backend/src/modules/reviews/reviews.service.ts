import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { buildTrustedManagedOriginCheck } from '../../common/trusted-managed-origin.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadReviewVote } from '../../entities/road-review-vote.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { OBJECT_STORAGE } from '../storage/storage.tokens.js';
import type { ObjectStorage } from '../storage/object-storage.interface.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import {
  ALLOWED_REVIEW_PHOTO_TYPES,
  CreateReviewDto,
  MAX_MY_REVIEW_VOTES,
  MAX_REVIEW_PHOTOS,
  MyReviewVoteDto,
  ReviewPhotosResponseDto,
  ReviewResponseDto,
  ReviewVoteResultDto,
  sanitizeReviewPhotos,
} from './dto/review.dto.js';
import {
  REVIEW_PHOTO_KEY_PREFIX,
  reviewPhotoFilenameFromKey,
  reviewPhotoKeyFromUrl,
} from './review-photo-storage-key.js';

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

function isOwnedManagedKey(
  key: string,
  segmentId: string,
  userId: string,
): boolean {
  return reviewPhotoFilenameFromKey(key).startsWith(
    buildOwnedPrefix(segmentId, userId),
  );
}

/**
 * Reject a `photos[]` payload that references a managed file the caller
 * doesn't own.
 *
 * `CreateReviewDto.photos` only validates URL shape, not authorization,
 * so without this check user B could attach user A's
 * `/road-review-photos/...` URL to B's own review — and then a later
 * `delete`/`update` on B's review would unlink the shared file out from
 * under A. Forcing every managed URL to carry the caller's
 * `<segmentId>-<userId>-` filename prefix means cascade deletes only ever
 * touch files the same user produced for the same segment.
 *
 * Third-party URLs that don't resolve to a managed key pass through
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
    const key = reviewPhotoKeyFromUrl(photoUrl, isTrustedOrigin);
    if (!key) continue;
    if (!isOwnedManagedKey(key, segmentId, userId)) {
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

interface VoteAggregate {
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
}

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  // Built once at construction so each create / update / delete doesn't
  // re-read TARMOTO_PUBLIC_BASE_URL / re-probe the storage. Closes the
  // loophole where a third-party URL with our managed pathname prefix
  // would be mis-classified as a managed photo (see
  // `buildTrustedManagedOriginCheck`).
  private readonly isTrustedManagedOrigin: (parsed: URL) => boolean;

  constructor(
    @InjectRepository(RoadReview)
    private readonly reviewRepo: Repository<RoadReview>,
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
    @InjectRepository(RoadReviewVote)
    private readonly voteRepo: Repository<RoadReviewVote>,
    private readonly privacy: PrivacyPreferencesService,
    private readonly featureResolver: FeatureResolver,
    @Inject(OBJECT_STORAGE)
    private readonly storage: ObjectStorage,
    config: ConfigService,
  ) {
    const baseCheck = buildTrustedManagedOriginCheck(config);
    const storageOrigin = this.deriveStorageOrigin();
    this.isTrustedManagedOrigin = (parsed: URL): boolean => {
      if (baseCheck(parsed)) return true;
      // For S3 deployments the bucket / CDN origin differs from the API
      // origin (`TARMOTO_PUBLIC_BASE_URL`). Photo URLs we emit point at
      // the CDN, so the cascade-delete + ownership guards must trust
      // that origin as managed too — otherwise our own URLs would be
      // classified as third-party and the guards would silently no-op.
      // LocalStorage returns relative URLs (no origin), so this only
      // adds the S3 case to the trusted set.
      if (storageOrigin && parsed.origin === storageOrigin) return true;
      return false;
    };
  }

  /**
   * Resolve the whole OSM way a segment belongs to as its set of sub-segment ids
   * (`COALESCE(osm_way_id, id)` match). A crowd-sourced row (null osm_way_id) is a
   * group of one, so this returns `[segmentId]` and behaviour is unchanged; an
   * imported ~100 m child expands to every sub-segment of its way. Used so reviews
   * are keyed on the logical ROAD, matching the aggregated /roads/:id detail (#809).
   */
  private async resolveWaySegmentIds(segmentId: string): Promise<string[]> {
    // Annotate the binding (rather than an `as` cast) so `rows` is typed under
    // both the local and the strict OpenAPI-gen tsconfigs, which disagree on
    // whether a cast here is redundant.
    const rows: Array<{ id: string }> = await this.segmentRepo.query(
      `SELECT rs.id
       FROM road_segments rs
       WHERE COALESCE(rs.osm_way_id::text, rs.id::text) = (
         SELECT COALESCE(osm_way_id::text, id::text)
         FROM road_segments WHERE id = $1 AND deactivated_at IS NULL
       )
         AND rs.deactivated_at IS NULL`,
      [segmentId],
    );
    return rows.map((r) => r.id);
  }

  /**
   * The viewer's own review anywhere on the requested id's whole way (a rider can
   * review a ROAD once, not once per ~100 m sub-segment). So a review posted to a
   * sibling sub-segment is still found for edit/delete via any id of the way,
   * keeping the write path consistent with the way-aggregated read path (#809).
   */
  private async findOwnReviewOnWay(
    userId: string,
    segmentId: string,
    relations: string[] = [],
  ): Promise<RoadReview | null> {
    const wayIds = await this.resolveWaySegmentIds(segmentId);
    if (wayIds.length === 0) return null;
    return this.reviewRepo.findOne({
      where: { user_id: userId, road_segment_id: In(wayIds) },
      relations,
    });
  }

  async listForSegment(
    segmentId: string,
    viewerUserId: string | null = null,
  ): Promise<ReviewResponseDto[]> {
    // Operator kill switch: hide reviews gracefully (never throw on a read).
    //
    // The community's reviews go, but the VIEWER'S OWN review stays. Returning
    // a bare `[]` here strands it: this list is the only place either client
    // exposes edit/delete from, so after a reload the rider's review is still
    // published, still theirs, and unremovable until the incident ends. A kill
    // switch must never trap user content — the same principle that leaves
    // `clearVote` and `delete` open below.
    //
    // Anonymous viewers still short-circuit with no DB work at all. For a
    // signed-in one we pay a way resolution plus one indexed lookup, which is
    // the cost of not trapping their content.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_poi_ratings'))
    ) {
      if (!viewerUserId) return [];
      const ownWayIds = await this.resolveWaySegmentIds(segmentId);
      if (ownWayIds.length === 0) return [];
      const own = await this.reviewRepo.find({
        where: { road_segment_id: In(ownWayIds), user_id: viewerUserId },
        relations: ['user'],
        order: { created_at: 'DESC' },
      });
      // Deliberately NOT through `aggregateVotes`: falling through the normal
      // pipeline would serialize `helpful_count` / `not_helpful_count` /
      // `my_vote` and reopen exactly the vote data this switch neutralises
      // everywhere else (including `clearVote`'s own response). Passing no
      // aggregate makes `toResponse` emit the neutral 0 / 0 / null triple.
      //
      // `authorIsPrivate: false` for the same reason as the self-view
      // exemption below — this row is only ever the viewer's own.
      return own.map((r) =>
        this.toResponse(r, undefined, viewerUserId, { authorIsPrivate: false }),
      );
    }
    // Reviews are keyed on the logical ROAD (the requested id's whole way), so the
    // panel matches the aggregated /roads/:id detail — a road's reviews are the
    // union across its ~100 m sub-segments (#809).
    const wayIds = await this.resolveWaySegmentIds(segmentId);
    if (wayIds.length === 0) return [];
    // Hidden (moderated) reviews stay out of the public list, but a rider
    // must still see their OWN hidden review — otherwise the mobile form
    // reads its absence as "create mode", the POST trips the unique
    // (user_id, road_segment_id) constraint (409), and the conflict reload
    // (this same list) can't surface the row to switch to edit/delete,
    // trapping the rider. Self-view exemption mirrors the privacy mask one
    // below: visible to everyone, plus the viewer's own rows regardless of
    // moderation_status.
    const reviews = await this.reviewRepo.find({
      where: viewerUserId
        ? [
            { road_segment_id: In(wayIds), moderation_status: 'visible' },
            { road_segment_id: In(wayIds), user_id: viewerUserId },
          ]
        : { road_segment_id: In(wayIds), moderation_status: 'visible' },
      relations: ['user'],
      order: { created_at: 'DESC' },
    });
    const voteMap = await this.aggregateVotes(
      reviews.map((r) => r.id),
      viewerUserId,
    );
    const privateAuthorIds = await this.privacy.loadPrivateUserIds(
      reviews.map((r) => r.user_id),
    );
    return reviews.map((r) =>
      this.toResponse(r, voteMap.get(r.id), viewerUserId, {
        // #279 / #501 — self-view exemption: a private rider must
        // still see their OWN review with their real name in the
        // listing (matches the `create` / `update` paths which pass
        // `authorIsPrivate: false` for the same reason — Codex /
        // Cursor Bugbot review on PR #513). The mask is about
        // hiding identity from OTHER riders, never from the rider
        // themselves.
        authorIsPrivate:
          privateAuthorIds.has(r.user_id) && r.user_id !== viewerUserId,
      }),
    );
  }

  async create(
    userId: string,
    segmentId: string,
    dto: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    // Operator kill switch: a write can't degrade to empty, so a clean 503 is
    // the honest response instead of silently dropping the submission.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_poi_ratings'))
    ) {
      throw new ServiceUnavailableException(
        'Reviews are temporarily unavailable',
      );
    }
    // Verify the segment exists AND is live — a review posted to a tombstoned
    // road (which /roads/:id 404s) would be saved but then hidden by the way
    // resolver, i.e. an invisible review (#835).
    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId, deactivated_at: IsNull() },
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

    // Freshly created reviews have no votes yet. The viewer is the
    // author themselves, so the privacy mask doesn't apply on this
    // path (`authorIsPrivate: false`).
    return this.toResponse(
      full!,
      {
        helpful_count: 0,
        not_helpful_count: 0,
        my_vote: null,
      },
      userId,
      { authorIsPrivate: false },
    );
  }

  async update(
    userId: string,
    segmentId: string,
    dto: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    // Operator kill switch: a write can't degrade to empty, so a clean 503 is
    // the honest response instead of silently dropping the edit.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_poi_ratings'))
    ) {
      throw new ServiceUnavailableException(
        'Reviews are temporarily unavailable',
      );
    }
    const review = await this.findOwnReviewOnWay(userId, segmentId, ['user']);
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    // The review may live on a sibling sub-segment of the way; its managed photos
    // are keyed to THAT segment, so ownership/cascade use the review's own segment
    // (identical to `segmentId` for a crowd-sourced group-of-one).
    const reviewSegmentId = review.road_segment_id;

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
      reviewSegmentId,
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
    // an orphan in storage. Run after save so a DB failure can't leave
    // the row pointing at a key we already deleted. The ownership filter
    // inside `deleteOwnedReviewPhotos` ensures we never delete a key
    // another user uploaded — even if a legacy row carries a foreign URL.
    const nextSet = new Set(nextPhotos);
    const removed = previousPhotos.filter((photo) => !nextSet.has(photo));
    await this.deleteOwnedReviewPhotos(removed, reviewSegmentId, userId);

    const voteMap = await this.aggregateVotes([saved.id], userId);
    // The viewer is the author here. Even if their profile is `private`,
    // surface their own name back to themselves — the masking gate is
    // about hiding identity from *other* riders, not from the rider
    // editing their own review.
    return this.toResponse(saved, voteMap.get(saved.id), userId, {
      authorIsPrivate: false,
    });
  }

  async delete(userId: string, segmentId: string): Promise<void> {
    const review = await this.findOwnReviewOnWay(userId, segmentId);
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    // Normalize so a legacy padded URL still resolves to the same managed
    // key the URL-resolver would otherwise miss. The review's own segment id keys
    // its managed photos (same as `segmentId` for a group-of-one).
    const reviewSegmentId = review.road_segment_id;
    const photos = normalizeReviewPhotoList(review.photos);
    await this.reviewRepo.remove(review);
    await this.deleteOwnedReviewPhotos(photos, reviewSegmentId, userId);
  }

  /**
   * Admin hard-delete: load → remove row → only if remove succeeded, purge
   * managed photos.
   *
   * The ordering guarantee mirrors `delete()`: photos are purged after the
   * row is removed so a DB failure can't leave the row pointing at files we
   * already deleted.
   *
   * Returns `true` when the row was deleted, `false` when no row was found.
   */
  async adminHardDelete(id: string): Promise<boolean> {
    const review = await this.reviewRepo.findOne({ where: { id } });
    if (!review) return false;
    const photos = normalizeReviewPhotoList(review.photos);
    await this.reviewRepo.remove(review);
    await this.deleteOwnedReviewPhotos(
      photos,
      review.road_segment_id,
      review.user_id,
    );
    return true;
  }

  /**
   * Persist uploaded review photo files to object storage and return the
   * URLs the caller should submit on the next `POST/PUT
   * /roads/:id/reviews`.
   *
   * The endpoint deliberately doesn't require the review to exist yet —
   * the typical flow is upload-then-create, and validating the segment
   * here would force a second roundtrip. Orphaned files (uploaded then
   * never attached) are accepted as a known cost; an S3 lifecycle sweep
   * is tracked separately. We do still verify the segment exists so
   * arbitrary UUIDs can't be used to spam the storage bucket.
   *
   * Storage routes through the pluggable `ObjectStorage` provider so a
   * prod deploy on multiple replicas can use S3 / R2 without sticky
   * uploads. `LocalStorage.publicUrl()` returns a server-relative
   * path which we lift to absolute via `publicBaseUrl` (mobile / web
   * clients pass the value straight to `<Image source>` and that doesn't
   * auto-resolve relative URLs); `S3Storage.publicUrl()` returns an
   * absolute CDN URL which we preserve verbatim. Same pattern as the
   * avatar upload flow.
   */
  async uploadPhotos(
    userId: string,
    segmentId: string,
    files: Express.Multer.File[],
    publicBaseUrl: string,
  ): Promise<ReviewPhotosResponseDto> {
    // Operator kill switch: a write can't degrade to empty, so a clean 503 is
    // the honest response instead of silently dropping the upload.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_poi_ratings'))
    ) {
      throw new ServiceUnavailableException(
        'Reviews are temporarily unavailable',
      );
    }
    if (files.length === 0) {
      throw new BadRequestException('At least one photo file is required');
    }
    if (files.length > MAX_REVIEW_PHOTOS) {
      throw new BadRequestException(
        `You can upload up to ${MAX_REVIEW_PHOTOS} photos at a time`,
      );
    }

    // Only accept photo uploads for a LIVE segment (mirrors create/detail): a
    // cached tombstoned id would otherwise stash uploads against a hidden road.
    const segment = await this.segmentRepo.findOne({
      where: { id: segmentId, deactivated_at: IsNull() },
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
      const key = `${REVIEW_PHOTO_KEY_PREFIX}${filename}`;
      return { file, key };
    });

    const written: string[] = [];
    try {
      for (const { file, key } of records) {
        await this.storage.put({
          key,
          body: file.buffer,
          contentType: file.mimetype,
        });
        written.push(key);
      }
    } catch (error) {
      // Roll back any partial writes (e.g. mid-batch storage failure) so
      // the caller either gets every URL it expected or none —
      // half-uploaded galleries would leak storage and confuse retry
      // logic on the client. Best-effort: a delete failure here mustn't
      // mask the original write error we're rethrowing.
      for (const key of written) {
        await this.storage.delete(key).catch(() => {});
      }
      throw error;
    }

    return {
      photos: written.map((key) =>
        this.buildAbsolutePhotoUrl(key, publicBaseUrl),
      ),
    };
  }

  /**
   * Lift a storage `publicUrl()` result to an absolute URL clients can
   * pass straight to `<Image source>`. LocalStorage returns
   * server-relative paths (`/uploads/road-review-photos/<file>`) — we
   * prefix the request's public base URL. S3 returns absolute CDN URLs
   * (`https://cdn.tarmoto.app/road-review-photos/<file>`) which we
   * preserve verbatim.
   */
  private buildAbsolutePhotoUrl(key: string, publicBaseUrl: string): string {
    const storageUrl = this.storage.publicUrl(key);
    return /^https?:\/\//.test(storageUrl)
      ? storageUrl
      : `${publicBaseUrl}${storageUrl}`;
  }

  /**
   * Best-effort delete of managed review-photo keys the caller owns,
   * out of the given URL list. Third-party URLs and managed keys
   * uploaded by another user are skipped silently — we never delete a
   * key we don't own. After-save / after-remove cascade deletes are
   * already past the point where the user-driven action succeeded, so a
   * transient storage error (S3 5xx, FS hiccup) is logged at warn level
   * rather than rethrown — the next upload (or a future GC sweep)
   * reclaims any orphan. Same posture as `cleanupPreviousAvatar`.
   */
  private async deleteOwnedReviewPhotos(
    photoUrls: readonly string[] | null | undefined,
    segmentId: string,
    userId: string,
  ): Promise<void> {
    if (!photoUrls?.length) return;
    for (const photoUrl of photoUrls) {
      const key = reviewPhotoKeyFromUrl(photoUrl, this.isTrustedManagedOrigin);
      if (!key) continue;
      // Defense in depth: even if `assertReviewPhotosAreOwned` was
      // bypassed (e.g. a legacy row predating the ownership rule), the
      // cascade-delete refuses to touch keys outside the caller's
      // `<segmentId>-<userId>-` namespace so removing review B can't
      // break review A.
      if (!isOwnedManagedKey(key, segmentId, userId)) continue;
      try {
        await this.storage.delete(key);
      } catch (error) {
        this.logger.warn(
          `Failed to clean up review photo ${key} for user ${userId}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }

  /**
   * Probe the configured `ObjectStorage` for the origin it emits public
   * URLs from, used to extend the trusted-managed-origin set.
   * `LocalStorage.publicUrl()` returns a server-relative path (no
   * scheme/origin) so this returns null and the API base URL stays the
   * sole trusted origin — exactly the LocalStorage posture today.
   * `S3Storage.publicUrl()` returns the bucket / CDN absolute URL, so
   * this returns that origin so our own URLs are recognized as managed.
   */
  private deriveStorageOrigin(): string | null {
    try {
      const probe = this.storage.publicUrl(`${REVIEW_PHOTO_KEY_PREFIX}probe`);
      if (!/^https?:\/\//.test(probe)) return null;
      return new URL(probe).origin;
    } catch {
      return null;
    }
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
    // Operator kill switch: a write can't degrade to empty, so a clean 503 is
    // the honest response instead of silently dropping the vote.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_poi_ratings'))
    ) {
      throw new ServiceUnavailableException(
        'Reviews are temporarily unavailable',
      );
    }
    const review = await this.reviewRepo.findOne({
      where: { id: reviewId, moderation_status: 'visible' },
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
    // The withdrawal itself is NOT gated by sys_poi_ratings: clearing a vote
    // is like `delete`, and a kill switch must never trap user content — a
    // rider must be able to retract a vote mid-incident. `castVote` (the
    // additive write) stays gated.
    const review = await this.reviewRepo.findOne({
      where: { id: reviewId, moderation_status: 'visible' },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    await this.voteRepo.delete({
      user_id: userId,
      road_review_id: reviewId,
    });
    // The RESPONSE aggregate is display data, though, and `voteRepo.delete`
    // is idempotent — so without this gate any caller could use this DELETE
    // as a read endpoint for the hidden vote counts while the switch is off
    // and `listForSegment`/road detail are zeroed. Skip the aggregate read
    // and return neutral counts, matching those degraded reads.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_poi_ratings'))
    ) {
      return { helpful_count: 0, not_helpful_count: 0, my_vote: null };
    }
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
   * List the caller's own helpful / not-helpful votes, newest first (#1177).
   *
   * Deliberately NOT gated by `sys_poi_ratings`, and deliberately NOT
   * degraded under it either: this is the discovery path for `clearVote`,
   * which stays open during a pause because a kill switch must never trap
   * user content — and a withdrawal endpoint keyed on a review id is only
   * "open" if the rider can still obtain that id. Ungating is safe because
   * every row here is the caller's OWN data (their vote, its direction, its
   * timestamp) plus segment map data for labelling; there are no aggregate
   * counts and no other rider's content in the projection, in EITHER switch
   * state — otherwise this read would reopen exactly the side channel
   * `clearVote` zeroes its response aggregate to close.
   *
   * Only votes on currently `visible` reviews are listed, mirroring the
   * lookup `clearVote` itself performs — a row this returns is therefore
   * always actually withdrawable, instead of advertising a DELETE that
   * would 404 on a moderated-away review.
   */
  async listMyVotes(userId: string): Promise<MyReviewVoteDto[]> {
    const rows = await this.voteRepo
      .createQueryBuilder('v')
      .innerJoin('v.road_review', 'r')
      // Left, not inner: a vote must never become unwithdrawable because of
      // segment-side state (deactivation flags live on the row, so this only
      // guards genuinely missing rows).
      .leftJoin('r.road_segment', 's')
      .select('v.road_review_id', 'review_id')
      .addSelect('v.is_helpful', 'is_helpful')
      .addSelect('v.updated_at', 'voted_at')
      .addSelect('r.road_segment_id', 'road_segment_id')
      .addSelect('s.road_name', 'road_name')
      .addSelect('s.road_number', 'road_number')
      .where('v.user_id = :userId', { userId })
      .andWhere('r.moderation_status = :visible', { visible: 'visible' })
      .orderBy('v.updated_at', 'DESC')
      .addOrderBy('v.road_review_id', 'DESC')
      .limit(MAX_MY_REVIEW_VOTES)
      .getRawMany<{
        review_id: string;
        is_helpful: boolean;
        voted_at: Date;
        road_segment_id: string;
        road_name: string | null;
        road_number: string | null;
      }>();

    return rows.map((row) => ({
      review_id: row.review_id,
      is_helpful: row.is_helpful,
      voted_at: row.voted_at.toISOString(),
      road_segment_id: row.road_segment_id,
      road_name: row.road_name ?? null,
      road_number: row.road_number ?? null,
    }));
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
    opts: { authorIsPrivate?: boolean } = {},
  ): ReviewResponseDto {
    // Soft-deleted authors are masked in feeds/profiles per GDPR
    // requirements (US-62) — the review row stays so historical
    // road-quality context is preserved, but the personal name is
    // hidden until the hard-delete sweep finishes the cascade.
    const authorVisible = review.user != null && review.user.deleted_at == null;
    // #279 / #501 — riders with `profile_visibility = 'private'` should
    // not have their display name leak onto the public reviews feed.
    // Mirrors the deleted-user mask above, but emits "Hidden rider" so
    // the UI can distinguish "rider opted out" from "rider purged" if
    // it wants to (currently both render the same string).
    const isAuthorPrivate = opts.authorIsPrivate === true;
    const isAuthorMasked = !authorVisible || isAuthorPrivate;
    const displayName = !authorVisible
      ? 'Deleted user'
      : isAuthorPrivate
        ? 'Hidden rider'
        : review.user.display_name;
    return {
      id: review.id,
      user_id: isAuthorMasked ? null : review.user_id,
      user_display_name: displayName,
      rating: review.rating,
      comment: review.comment,
      bike_model: review.bike_model,
      // #279 / #501 — managed review photos are stored under
      // `/road-review-photos/<segmentId>-<userId>-<ts>-...`, so
      // emitting the URLs while masking `user_id`/name would leak
      // the rider's UUID through the filename (Codex review on PR
      // #513 r3212896111). Suppress the photo list entirely on the
      // masked path. Self-views aren't masked (`isAuthorPrivate`
      // is false for `r.user_id === viewerUserId` in
      // `listForSegment`), so a private rider editing their own
      // review still sees their own attachments.
      photos: isAuthorMasked ? null : sanitizeReviewPhotos(review.photos),
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
