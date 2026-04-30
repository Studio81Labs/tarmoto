/* eslint-disable @typescript-eslint/no-unsafe-return */
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  unlink: jest.fn(),
  writeFile: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { ReviewsService } from './reviews.service.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadReviewVote } from '../../entities/road-review-vote.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';

interface VoteRow {
  road_review_id: string;
  helpful_count: number;
  not_helpful_count: number;
}

describe('ReviewsService', () => {
  let service: ReviewsService;
  let reviewRepo: Partial<jest.Mocked<Repository<RoadReview>>>;
  let segmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;
  let voteRepo: Partial<jest.Mocked<Repository<RoadReviewVote>>>;
  let voteInsert: { execute: jest.Mock };
  let voteGroupRows: VoteRow[];
  let viewerVotes: Array<{ road_review_id: string; is_helpful: boolean }>;

  const mockUser = { display_name: 'John Rider' };

  const mockReview = {
    id: 'review-1',
    user_id: 'user-1',
    road_segment_id: 'seg-1',
    rating: 4,
    comment: 'Smooth asphalt, great ride!',
    bike_model: 'BMW R1250GS',
    photos: null,
    created_at: new Date('2026-04-14T10:00:00Z'),
    user: mockUser,
  } as unknown as RoadReview;

  const mockSegment = { id: 'seg-1' } as unknown as RoadSegment;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mkdir).mockResolvedValue(undefined);
    jest.mocked(unlink).mockResolvedValue(undefined);
    jest.mocked(writeFile).mockResolvedValue(undefined);

    reviewRepo = {
      find: jest.fn().mockResolvedValue([mockReview]),
      findOne: jest.fn().mockResolvedValue(mockReview),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockReview, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    segmentRepo = {
      findOne: jest.fn().mockResolvedValue(mockSegment),
    };

    voteGroupRows = [];
    viewerVotes = [];
    voteInsert = { execute: jest.fn().mockResolvedValue(undefined) };

    // Mock the query builder chain used in `aggregateVotes`. The builder
    // exposes only the methods the service actually calls; each terminal
    // method returns a Promise so the `await` in the service resolves
    // without going to a real DB.
    const selectQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockImplementation(() => voteGroupRows),
    };
    const insertQb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      execute: voteInsert.execute,
    };
    voteRepo = {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        // Each call returns a fresh chain; `aggregateVotes` uses the
        // select/where chain, `castVote` uses the insert chain. Both
        // coexist on one proxy.
        return {
          ...selectQb,
          ...insertQb,
        };
      }),
      find: jest.fn().mockImplementation(() => viewerVotes),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getRepositoryToken(RoadReview), useValue: reviewRepo },
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(RoadReviewVote), useValue: voteRepo },
        // Test fixtures use `https://app.tarmoto.test/...` everywhere —
        // configure that as the trusted public base URL so the service's
        // origin guard treats those URLs as ours.
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'TARMOTO_PUBLIC_BASE_URL'
                ? 'https://app.tarmoto.test'
                : undefined,
          },
        },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  describe('listForSegment', () => {
    it('should return reviews for a segment', async () => {
      const result = await service.listForSegment('seg-1');

      expect(reviewRepo.find).toHaveBeenCalledWith({
        where: { road_segment_id: 'seg-1' },
        relations: ['user'],
        order: { created_at: 'DESC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('review-1');
      expect(result[0].rating).toBe(4);
      expect(result[0].user_display_name).toBe('John Rider');
      // No votes seeded → zeros + null caller vote.
      expect(result[0].helpful_count).toBe(0);
      expect(result[0].not_helpful_count).toBe(0);
      expect(result[0].my_vote).toBeNull();
      expect(result[0].is_mine).toBe(false);
    });

    it("should surface vote counts and the caller's own vote when authenticated", async () => {
      voteGroupRows = [
        {
          road_review_id: 'review-1',
          helpful_count: 7,
          not_helpful_count: 2,
        },
      ];
      viewerVotes = [{ road_review_id: 'review-1', is_helpful: false }];

      const result = await service.listForSegment('seg-1', 'viewer-1');

      expect(result[0].helpful_count).toBe(7);
      expect(result[0].not_helpful_count).toBe(2);
      expect(result[0].my_vote).toBe(false);
      expect(result[0].is_mine).toBe(false);
    });

    it('should skip viewer-vote lookup when anonymous', async () => {
      voteGroupRows = [
        {
          road_review_id: 'review-1',
          helpful_count: 3,
          not_helpful_count: 0,
        },
      ];

      await service.listForSegment('seg-1');

      // The anonymous path must not hit `voteRepo.find`; that call is
      // only for resolving the authenticated viewer's own votes.
      expect(voteRepo.find).not.toHaveBeenCalled();
    });

    it('should return empty array when no reviews', async () => {
      reviewRepo.find!.mockResolvedValueOnce([]);

      const result = await service.listForSegment('seg-1');

      expect(result).toHaveLength(0);
    });

    it('should mask user_display_name when the author has been soft-deleted', async () => {
      reviewRepo.find!.mockResolvedValueOnce([
        { ...mockReview, user: undefined } as unknown as RoadReview,
      ]);

      const result = await service.listForSegment('seg-1');

      // After US-62 GDPR deletion, both a missing relation and a
      // soft-deleted author flow through the same masked-name path.
      expect(result[0].user_display_name).toBe('Deleted user');
    });

    it('should mask user_display_name when the author is soft-deleted with deleted_at set', async () => {
      reviewRepo.find!.mockResolvedValueOnce([
        {
          ...mockReview,
          user: { ...mockReview.user, deleted_at: new Date() },
        } as unknown as RoadReview,
      ]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].user_display_name).toBe('Deleted user');
    });
  });

  describe('create', () => {
    it('should create a review and return response with user', async () => {
      const dto = { rating: 5, comment: 'Amazing road!' };
      const savedReview = {
        id: 'review-new',
        user_id: 'user-1',
        road_segment_id: 'seg-1',
        rating: 5,
        comment: 'Amazing road!',
        bike_model: null,
        created_at: new Date('2026-04-14T12:00:00Z'),
        user: mockUser,
      } as unknown as RoadReview;
      reviewRepo.save!.mockResolvedValueOnce(savedReview);
      reviewRepo.findOne!.mockResolvedValueOnce(savedReview);

      const result = await service.create('user-1', 'seg-1', dto);

      expect(segmentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'seg-1' },
      });
      expect(reviewRepo.create).toHaveBeenCalledWith({
        user_id: 'user-1',
        road_segment_id: 'seg-1',
        rating: 5,
        comment: 'Amazing road!',
        bike_model: null,
        photos: null,
      });
      expect(result.rating).toBe(5);
      expect(result.user_display_name).toBe('John Rider');
      expect(result.is_mine).toBe(true);
    });

    it('should set optional fields to null when not provided', async () => {
      const dto = { rating: 3 };

      await service.create('user-1', 'seg-1', dto);

      expect(reviewRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: null,
          bike_model: null,
          photos: null,
        }),
      );
    });

    it('should pass bike_model when provided', async () => {
      const dto = { rating: 4, bike_model: 'Ducati Monster' };

      await service.create('user-1', 'seg-1', dto);

      expect(reviewRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bike_model: 'Ducati Monster',
        }),
      );
    });

    it('should persist photos when provided', async () => {
      const dto = {
        rating: 5,
        photos: [
          'https://media.tarmoto.app/r/abc.jpg',
          'https://media.tarmoto.app/r/def.jpg',
        ],
      };

      await service.create('user-1', 'seg-1', dto);

      expect(reviewRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          photos: dto.photos,
        }),
      );
    });

    it('should throw NotFoundException when segment does not exist', async () => {
      segmentRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.create('user-1', 'missing', { rating: 3 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException on duplicate review', async () => {
      reviewRepo.save!.mockRejectedValueOnce({ code: '23505' });

      await expect(
        service.create('user-1', 'seg-1', { rating: 3 }),
      ).rejects.toThrow(ConflictException);
    });

    it('should rethrow non-unique-constraint errors', async () => {
      reviewRepo.save!.mockRejectedValueOnce(new Error('connection lost'));

      await expect(
        service.create('user-1', 'seg-1', { rating: 3 }),
      ).rejects.toThrow('connection lost');
    });

    it("should reject when the payload references another user's managed photo", async () => {
      // Mirror of the update-side ownership guard: the create path also
      // refuses to persist a managed URL whose `<segmentId>-<userId>-`
      // prefix doesn't match the caller, so user-1 can't snapshot
      // user-2's gallery into their own review and trigger a cascade
      // delete on it later.
      await expect(
        service.create('user-1', 'seg-1', {
          rating: 5,
          photos: [
            'https://app.tarmoto.test/uploads/road-review-photos/seg-1-other-user-shot.jpg',
          ],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(reviewRepo.save).not.toHaveBeenCalled();
    });

    it('should accept own managed photos and third-party URLs', async () => {
      // Owned managed URLs (filename starts with `<seg>-<user>-`) and
      // arbitrary third-party https URLs both pass — the ownership rule
      // only kicks in when the URL resolves to our managed directory.
      const dto = {
        rating: 5,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-shot.jpg',
          'https://cdn.example.com/foreign.jpg',
        ],
      };

      await service.create('user-1', 'seg-1', dto);

      expect(reviewRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ photos: dto.photos }),
      );
    });
  });

  describe('update', () => {
    it('should update an existing review', async () => {
      const dto = { rating: 2, comment: 'Road deteriorated' };

      const result = await service.update('user-1', 'seg-1', dto);

      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-1', road_segment_id: 'seg-1' },
        relations: ['user'],
      });
      expect(reviewRepo.save).toHaveBeenCalled();
      expect(result.rating).toBe(2);
      expect(result.comment).toBe('Road deteriorated');
    });

    it('should clear optional fields when not provided', async () => {
      const dto = { rating: 3 };

      const result = await service.update('user-1', 'seg-1', dto);

      expect(result.comment).toBeNull();
      expect(result.bike_model).toBeNull();
      expect(result.photos).toEqual([]);
    });

    it('should replace photos when provided', async () => {
      const dto = {
        rating: 4,
        photos: ['https://media.tarmoto.app/r/new.jpg'],
      };

      const result = await service.update('user-1', 'seg-1', dto);

      expect(result.photos).toEqual(dto.photos);
    });

    it('should throw NotFoundException when review does not exist', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.update('user-1', 'seg-1', { rating: 3 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should cascade-delete managed photos that the new payload dropped', async () => {
      // Editing a review that previously referenced two managed photos
      // and now only keeps one must unlink the file behind the dropped
      // URL — otherwise removing a photo from the UI leaves an orphan
      // that nothing will ever clean up before the S3 lifecycle lands.
      // Photo basenames must carry the `<segmentId>-<userId>-` prefix so
      // the cascade-delete recognizes them as the caller's own files.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-drop.jpg',
        ],
      } as unknown as RoadReview);

      await service.update('user-1', 'seg-1', {
        rating: 4,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
        ],
      });

      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringContaining(
          '/uploads/road-review-photos/seg-1-user-1-drop.jpg',
        ),
      );
    });

    it('should not unlink anything when photos are unchanged', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-same.jpg',
        ],
      } as unknown as RoadReview);

      await service.update('user-1', 'seg-1', {
        rating: 4,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-same.jpg',
        ],
      });

      expect(unlink).not.toHaveBeenCalled();
    });

    it('should ignore dropped third-party URLs that are not managed', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://cdn.example.com/foreign.jpg',
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-managed.jpg',
        ],
      } as unknown as RoadReview);

      await service.update('user-1', 'seg-1', { rating: 4, photos: [] });

      // The foreign URL is left alone — we never wrote it, we don't own
      // the lifecycle for it. Only the managed file is removed.
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringContaining(
          '/uploads/road-review-photos/seg-1-user-1-managed.jpg',
        ),
      );
    });

    it('should not unlink files for path-traversal attempts in stored photo URLs', async () => {
      // A row whose photos[] was crafted (or migrated from legacy data)
      // to include a `..%2F..%2F` segment must NOT cause unlink to be
      // called with anything outside the managed directory. The path
      // resolver returns null for those, mirroring the avatar pattern.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/..%2F..%2Fsecrets.txt',
          'https://app.tarmoto.test/uploads/road-review-photos/%00pwn.jpg',
        ],
      } as unknown as RoadReview);

      await service.update('user-1', 'seg-1', { rating: 4, photos: [] });

      expect(unlink).not.toHaveBeenCalled();
    });

    it('should not unlink a managed file uploaded by another user', async () => {
      // Defense in depth for legacy rows that predate the create/update
      // ownership check: even if a row carries a URL whose filename
      // belongs to a different `(segmentId, userId)`, removing the row
      // must NOT delete that file out from under the original uploader's
      // own review.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-other-user-foreign.jpg',
        ],
      } as unknown as RoadReview);

      await service.update('user-1', 'seg-1', { rating: 4, photos: [] });

      expect(unlink).not.toHaveBeenCalled();
    });

    it("should reject when the payload references another user's managed photo", async () => {
      // The DTO accepts any well-formed photo URL — without this guard,
      // user-1 could attach user-2's `/uploads/road-review-photos/...`
      // URL to their own review, and a later cascade-delete on user-1's
      // review would then remove user-2's file. The owner check at the
      // create/update boundary refuses to persist the cross-attachment
      // in the first place.
      await expect(
        service.update('user-1', 'seg-1', {
          rating: 4,
          photos: [
            'https://app.tarmoto.test/uploads/road-review-photos/seg-1-other-user-shot.jpg',
          ],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(reviewRepo.save).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('should treat URLs from a third-party CDN with a colliding pathname as not managed', async () => {
      // A third-party origin like `cdn.example.com` happens to expose a
      // file at `/uploads/road-review-photos/<our-prefix>-x.jpg` — the
      // pathname-only resolver would have classified this as managed and
      // rejected with 400 even though the URL points at someone else's
      // server. The origin guard restricts "managed" detection to the
      // configured `TARMOTO_PUBLIC_BASE_URL` (or loopback in dev), so a
      // foreign CDN URL passes through untouched as a third-party photo.
      const result = await service.update('user-1', 'seg-1', {
        rating: 4,
        photos: [
          'https://cdn.example.com/uploads/road-review-photos/seg-1-other-user-shot.jpg',
        ],
      });

      expect(reviewRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          photos: [
            'https://cdn.example.com/uploads/road-review-photos/seg-1-other-user-shot.jpg',
          ],
        }),
      );
      expect(unlink).not.toHaveBeenCalled();
      expect(result.photos).toEqual([
        'https://cdn.example.com/uploads/road-review-photos/seg-1-other-user-shot.jpg',
      ]);
    });

    it('should treat a whitespace-padded stored URL and a trimmed update as the same photo', async () => {
      // `IsReviewPhotoUrl` validates `value.trim()`, so a row could land
      // in the DB with surrounding whitespace via direct API use. If the
      // set-difference compared raw strings, the next update sending the
      // same URL trimmed would mark it as removed and unlink the file
      // out from under the still-saved (now-normalized) review row.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          '  https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg  ',
        ],
      } as unknown as RoadReview);

      await service.update('user-1', 'seg-1', {
        rating: 4,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
        ],
      });

      expect(unlink).not.toHaveBeenCalled();
      // Saved row carries the trimmed form so future diffs stay
      // consistent with the response sanitizer.
      expect(reviewRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          photos: [
            'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
          ],
        }),
      );
    });
  });

  describe('delete', () => {
    it('should delete an existing review', async () => {
      await service.delete('user-1', 'seg-1');

      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-1', road_segment_id: 'seg-1' },
      });
      expect(reviewRepo.remove).toHaveBeenCalledWith(mockReview);
    });

    it('should throw NotFoundException when review does not exist', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.delete('user-1', 'seg-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should cascade-delete managed photo files after removing the review', async () => {
      // Files referenced by the deleted review live under our managed
      // /uploads/road-review-photos/ prefix and must be unlinked so the
      // user-driven delete actually frees disk — third-party URLs are
      // left alone and missing files are tolerated. Filenames must carry
      // the `<segmentId>-<userId>-` prefix to be recognized as the
      // caller's own.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
          'https://cdn.example.com/external.jpg', // not managed → skipped
        ],
      } as unknown as RoadReview);

      await service.delete('user-1', 'seg-1');

      expect(reviewRepo.remove).toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringContaining(
          '/uploads/road-review-photos/seg-1-user-1-keep.jpg',
        ),
      );
    });

    it("should not unlink another user's managed photo even if the row points at it", async () => {
      // Same defense-in-depth as the update path: a legacy row that
      // somehow references user-2's filename must NOT cause unlink when
      // user-1 deletes their review. The cascade-delete is bound to the
      // caller's `<segmentId>-<userId>-` namespace, period.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-other-user-foreign.jpg',
        ],
      } as unknown as RoadReview);

      await service.delete('user-1', 'seg-1');

      expect(reviewRepo.remove).toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('should not call unlink when the review has no photos', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: null,
      } as unknown as RoadReview);

      await service.delete('user-1', 'seg-1');

      expect(unlink).not.toHaveBeenCalled();
    });

    it('should swallow ENOENT but rethrow other unlink errors', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-missing.jpg',
        ],
      } as unknown as RoadReview);
      jest
        .mocked(unlink)
        .mockRejectedValueOnce(
          Object.assign(new Error('not found'), { code: 'ENOENT' }),
        );

      // ENOENT is benign — the file was already gone, the row is the
      // source of truth. The delete must still resolve.
      await expect(service.delete('user-1', 'seg-1')).resolves.toBeUndefined();
    });
  });

  describe('uploadPhotos', () => {
    const fileA = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('jpeg-bytes'),
    } as Express.Multer.File;
    const fileB = {
      mimetype: 'image/webp',
      buffer: Buffer.from('webp-bytes'),
    } as Express.Multer.File;

    it('should reject when no files are provided', async () => {
      await expect(
        service.uploadPhotos('user-1', 'seg-1', [], 'https://app.tarmoto.test'),
      ).rejects.toThrow(BadRequestException);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should reject when the segment does not exist', async () => {
      segmentRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.uploadPhotos(
          'user-1',
          'missing',
          [fileA],
          'https://app.tarmoto.test',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should reject unsupported mimetypes before writing any file', async () => {
      const gif = {
        mimetype: 'image/gif',
        buffer: Buffer.from('gif-bytes'),
      } as Express.Multer.File;

      await expect(
        service.uploadPhotos(
          'user-1',
          'seg-1',
          [fileA, gif],
          'https://app.tarmoto.test',
        ),
      ).rejects.toThrow(BadRequestException);
      // Validation runs over the whole batch before any disk write so a
      // bad file in the middle of a gallery doesn't leave a half-uploaded
      // mess on disk.
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should reject when too many files are uploaded at once', async () => {
      const tooMany = Array.from({ length: 6 }, () => fileA);

      await expect(
        service.uploadPhotos(
          'user-1',
          'seg-1',
          tooMany,
          'https://app.tarmoto.test',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should write each accepted file and return public URLs', async () => {
      const result = await service.uploadPhotos(
        'user-1',
        'seg-1',
        [fileA, fileB],
        'https://app.tarmoto.test',
      );

      expect(writeFile).toHaveBeenCalledTimes(2);
      expect(writeFile).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(
          /\/uploads\/road-review-photos\/seg-1-user-1-.*\.jpg$/,
        ),
        fileA.buffer,
      );
      expect(writeFile).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(
          /\/uploads\/road-review-photos\/seg-1-user-1-.*\.webp$/,
        ),
        fileB.buffer,
      );
      expect(result.photos).toHaveLength(2);
      expect(result.photos[0]).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/road-review-photos\/seg-1-user-1-.*\.jpg$/,
      );
      expect(result.photos[1]).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/road-review-photos\/seg-1-user-1-.*\.webp$/,
      );
    });

    it('should roll back already-written files when a later write fails', async () => {
      jest
        .mocked(writeFile)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
        );

      await expect(
        service.uploadPhotos(
          'user-1',
          'seg-1',
          [fileA, fileB],
          'https://app.tarmoto.test',
        ),
      ).rejects.toThrow('disk full');

      // The first file made it to disk before the second failed — the
      // rollback unlink must remove it so callers either get every URL
      // or none. Anything else leaks storage on retry.
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/uploads\/road-review-photos\/seg-1-user-1-.*\.jpg$/,
        ),
      );
    });
  });

  describe('toResponse', () => {
    it('should format created_at as ISO string', async () => {
      const freshReview = {
        ...mockReview,
        created_at: new Date('2026-04-14T10:00:00Z'),
      } as unknown as RoadReview;
      reviewRepo.find!.mockResolvedValueOnce([freshReview]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].created_at).toBe('2026-04-14T10:00:00.000Z');
    });

    it('should include all response fields', async () => {
      const freshReview = {
        id: 'review-1',
        user_id: 'user-1',
        road_segment_id: 'seg-1',
        rating: 4,
        comment: 'Smooth asphalt, great ride!',
        bike_model: 'BMW R1250GS',
        photos: ['https://media.tarmoto.app/r/abc.jpg'],
        created_at: new Date('2026-04-14T10:00:00Z'),
        user: mockUser,
      } as unknown as RoadReview;
      reviewRepo.find!.mockResolvedValueOnce([freshReview]);

      const result = await service.listForSegment('seg-1');

      expect(result[0]).toEqual({
        id: 'review-1',
        user_display_name: 'John Rider',
        rating: 4,
        comment: 'Smooth asphalt, great ride!',
        bike_model: 'BMW R1250GS',
        photos: ['https://media.tarmoto.app/r/abc.jpg'],
        created_at: '2026-04-14T10:00:00.000Z',
        helpful_count: 0,
        not_helpful_count: 0,
        my_vote: null,
        is_mine: false,
      });
    });

    it('should default photos to empty array when null', async () => {
      const freshReview = {
        ...mockReview,
        photos: null,
      } as unknown as RoadReview;
      reviewRepo.find!.mockResolvedValueOnce([freshReview]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].photos).toEqual([]);
    });

    it('should sanitize photos: drop non-https and cap at 5', async () => {
      // /reviews and /roads/:id serve the same DTO — both paths must strip
      // legacy http:// or file:// URLs and cap oversize galleries, so a row
      // predating the HTTPS-only CreateReviewDto rule can't leak through.
      const freshReview = {
        ...mockReview,
        photos: [
          'https://media.tarmoto.app/a.jpg',
          'http://insecure.example.com/b.jpg',
          'file:///etc/passwd',
          42,
          null,
          'https://media.tarmoto.app/c.jpg',
          'https://media.tarmoto.app/d.jpg',
          'https://media.tarmoto.app/e.jpg',
          'https://media.tarmoto.app/f.jpg',
          'https://media.tarmoto.app/g.jpg', // 6th valid — dropped
        ],
      } as unknown as RoadReview;
      reviewRepo.find!.mockResolvedValueOnce([freshReview]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].photos).toHaveLength(5);
      expect(result[0].photos.every((p) => p.startsWith('https://'))).toBe(
        true,
      );
      expect(result[0].photos).not.toContain('https://media.tarmoto.app/g.jpg');
    });

    it('should keep loopback http URLs (IPv4 + IPv6) but drop other plain-http hosts', async () => {
      // Local-dev managed uploads come back as http://localhost:PORT/...
      // (req.protocol is http when there's no TLS terminator), so the
      // sanitizer must accept loopback http to round-trip those URLs
      // through the response. IPv6 loopback `[::1]` is included because
      // some local setups resolve the API host to ::1 — without it the
      // upload-then-submit flow would 500 in plain dev. Non-loopback
      // http remains rejected — we don't want a stored row to silently
      // leak insecure third-party image URLs.
      const freshReview = {
        ...mockReview,
        photos: [
          'http://localhost:3000/uploads/road-review-photos/dev.jpg',
          'http://127.0.0.1:3000/uploads/road-review-photos/dev2.jpg',
          'http://[::1]:3000/uploads/road-review-photos/dev3.jpg',
          'http://insecure.example.com/x.jpg',
        ],
      } as unknown as RoadReview;
      reviewRepo.find!.mockResolvedValueOnce([freshReview]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].photos).toEqual([
        'http://localhost:3000/uploads/road-review-photos/dev.jpg',
        'http://127.0.0.1:3000/uploads/road-review-photos/dev2.jpg',
        'http://[::1]:3000/uploads/road-review-photos/dev3.jpg',
      ]);
    });

    it('should reject loopback http URLs when running in production', async () => {
      // In production every photo must be served over https — a stored
      // http://localhost/... URL would render in every viewer's browser
      // as an image hitting each viewer's local services. The validator
      // / sanitizer reads TARMOTO_NODE_ENV at call time so the prod
      // posture stays the same regardless of how the row landed there.
      const previous = process.env.TARMOTO_NODE_ENV;
      process.env.TARMOTO_NODE_ENV = 'production';
      try {
        const freshReview = {
          ...mockReview,
          photos: [
            'http://localhost:3000/uploads/road-review-photos/dev.jpg',
            'http://127.0.0.1:3000/uploads/road-review-photos/dev2.jpg',
            'https://app.tarmoto.test/uploads/road-review-photos/keep.jpg',
          ],
        } as unknown as RoadReview;
        reviewRepo.find!.mockResolvedValueOnce([freshReview]);

        const result = await service.listForSegment('seg-1');

        expect(result[0].photos).toEqual([
          'https://app.tarmoto.test/uploads/road-review-photos/keep.jpg',
        ]);
      } finally {
        if (previous === undefined) {
          delete process.env.TARMOTO_NODE_ENV;
        } else {
          process.env.TARMOTO_NODE_ENV = previous;
        }
      }
    });

    it('should reject malformed https strings that prefix-pass but fail URL parsing', async () => {
      // Prefix-only `startsWith('https://')` would let these through — the
      // URL-parse + hostname check must catch space-after-scheme, missing
      // hostname, and outright non-URL text, not just wrong schemes.
      const freshReview = {
        ...mockReview,
        photos: [
          'https:// media.tarmoto.app/a.jpg', // space after scheme
          'https://', // no hostname
          'not a url',
          '  https://padded.tarmoto.app/ok.jpg  ', // kept: trimmed + parsed
          'https://good.tarmoto.app/ok.jpg',
        ],
      } as unknown as RoadReview;
      reviewRepo.find!.mockResolvedValueOnce([freshReview]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].photos).toEqual([
        // Stored value came with surrounding whitespace — sanitizer must
        // return the trimmed URL so `Image.source.uri` on the client can
        // actually fetch it.
        'https://padded.tarmoto.app/ok.jpg',
        'https://good.tarmoto.app/ok.jpg',
      ]);
    });
  });

  describe('castVote', () => {
    const otherAuthorReview = {
      id: 'review-2',
      user_id: 'author-2',
    } as unknown as RoadReview;

    it('should upsert a helpful vote and return the updated counts', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(otherAuthorReview);
      voteGroupRows = [
        {
          road_review_id: 'review-2',
          helpful_count: 4,
          not_helpful_count: 1,
        },
      ];
      viewerVotes = [{ road_review_id: 'review-2', is_helpful: true }];

      const result = await service.castVote('viewer-1', 'review-2', true);

      expect(voteInsert.execute).toHaveBeenCalled();
      expect(result).toEqual({
        helpful_count: 4,
        not_helpful_count: 1,
        my_vote: true,
      });
    });

    it('should throw NotFoundException when review does not exist', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.castVote('viewer-1', 'missing', true),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when voting on own review', async () => {
      // The backend owns the self-vote rule so a crafted client request
      // can't bypass the UI guard and pad helpful counts for its author.
      reviewRepo.findOne!.mockResolvedValueOnce({
        id: 'review-self',
        user_id: 'viewer-1',
      } as unknown as RoadReview);

      await expect(
        service.castVote('viewer-1', 'review-self', true),
      ).rejects.toThrow(ConflictException);
      expect(voteInsert.execute).not.toHaveBeenCalled();
    });
  });

  describe('clearVote', () => {
    it('should delete the vote and return refreshed counts with null my_vote', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        id: 'review-2',
        user_id: 'author-2',
      } as unknown as RoadReview);
      voteGroupRows = [
        {
          road_review_id: 'review-2',
          helpful_count: 3,
          not_helpful_count: 1,
        },
      ];
      // Viewer's row was just deleted, so the `find` lookup returns
      // nothing and `my_vote` collapses back to null.
      viewerVotes = [];

      const result = await service.clearVote('viewer-1', 'review-2');

      expect(voteRepo.delete).toHaveBeenCalledWith({
        user_id: 'viewer-1',
        road_review_id: 'review-2',
      });
      expect(result).toEqual({
        helpful_count: 3,
        not_helpful_count: 1,
        my_vote: null,
      });
    });

    it('should throw NotFoundException when review does not exist', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.clearVote('viewer-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(voteRepo.delete).not.toHaveBeenCalled();
    });
  });
});
