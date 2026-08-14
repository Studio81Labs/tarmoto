/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  Logger,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In, IsNull, Repository } from 'typeorm';
import { Readable } from 'node:stream';
import { ReviewsService } from './reviews.service.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadReviewVote } from '../../entities/road-review-vote.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { OBJECT_STORAGE } from '../storage/storage.tokens.js';
import type { ObjectStorage } from '../storage/object-storage.interface.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

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
  let storage: jest.Mocked<ObjectStorage>;
  let configGet: jest.Mock;
  let privacy: { loadPrivateUserIds: jest.Mock };
  let featureResolver: jest.Mocked<
    Pick<FeatureResolver, 'isSystemSwitchEnabled'>
  >;
  // Default — empty set → no author is private. Per-test overrides
  // populate this with specific user ids to exercise the mask via
  // `PrivacyPreferencesService.loadPrivateUserIds`.
  let privateUserIds: Set<string>;

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

  // Build a service whose storage mock returns LocalStorage-shape URLs
  // (server-relative). The default test fixture uses
  // `https://app.tarmoto.test` as the trusted public base URL — same
  // origin every managed-photo URL in the asserts is anchored at.
  const createService = async (
    storageOverrides: Partial<jest.Mocked<ObjectStorage>> = {},
  ): Promise<void> => {
    storage = {
      put: jest.fn().mockResolvedValue({ byteSize: 12 }),
      read: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
      // Default: LocalStorage-style relative URL — exercises the
      // service's "lift to absolute via publicBaseUrl" branch and the
      // managed-origin trust set built from `TARMOTO_PUBLIC_BASE_URL`.
      publicUrl: jest
        .fn()
        .mockImplementation((key: string) => `/uploads/${key}`),
      signedUrl: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(`/uploads/${key}`),
        ),
      ...storageOverrides,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getRepositoryToken(RoadReview), useValue: reviewRepo },
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(RoadReviewVote), useValue: voteRepo },
        { provide: PrivacyPreferencesService, useValue: privacy },
        { provide: OBJECT_STORAGE, useValue: storage },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();

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
      // `resolveWaySegmentIds` — a crowd-sourced row is a group of one, so the
      // requested id maps to just itself and the reviews query is unchanged.
      query: jest.fn().mockResolvedValue([{ id: 'seg-1' }]),
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
        return {
          ...selectQb,
          ...insertQb,
        };
      }),
      find: jest.fn().mockImplementation(() => viewerVotes),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    privateUserIds = new Set();
    privacy = {
      loadPrivateUserIds: jest
        .fn()
        .mockImplementation(() => Promise.resolve(new Set(privateUserIds))),
    };

    // Defaults the switch ON so every pre-existing test below is
    // unaffected; the off-case tests set their own mock resolving `false`.
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    // Test fixtures use `https://app.tarmoto.test/...` everywhere —
    // configure that as the trusted public base URL so the service's
    // origin guard treats those URLs as ours.
    configGet = jest
      .fn()
      .mockImplementation((key: string) =>
        key === 'TARMOTO_PUBLIC_BASE_URL'
          ? 'https://app.tarmoto.test'
          : undefined,
      );

    await createService();
  });

  describe('listForSegment', () => {
    it('should return reviews for a segment', async () => {
      const result = await service.listForSegment('seg-1');

      expect(reviewRepo.find).toHaveBeenCalledWith({
        where: { road_segment_id: In(['seg-1']), moderation_status: 'visible' },
        relations: ['user'],
        order: { created_at: 'DESC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('review-1');
      expect(result[0].rating).toBe(4);
      expect(result[0].user_display_name).toBe('John Rider');
      // user_id ships alongside display_name so review cards can deep-link
      // to the rider profile without a second round trip (#335).
      expect(result[0].user_id).toBe('user-1');
      // No votes seeded → zeros + null caller vote.
      expect(result[0].helpful_count).toBe(0);
      expect(result[0].not_helpful_count).toBe(0);
      expect(result[0].my_vote).toBeNull();
      expect(result[0].is_mine).toBe(false);
    });

    it("aggregates reviews across the requested id's whole OSM way (#809)", async () => {
      // An imported ~100 m child resolves to every sub-segment of its way, so the
      // panel matches the aggregated /roads/:id detail.
      segmentRepo.query!.mockResolvedValueOnce([
        { id: 'seg-1' },
        { id: 'seg-2' },
        { id: 'seg-3' },
      ]);

      await service.listForSegment('seg-1');

      expect(segmentRepo.query).toHaveBeenCalledWith(expect.any(String), [
        'seg-1',
      ]);
      expect(reviewRepo.find).toHaveBeenCalledWith({
        where: {
          road_segment_id: In(['seg-1', 'seg-2', 'seg-3']),
          moderation_status: 'visible',
        },
        relations: ['user'],
        order: { created_at: 'DESC' },
      });
    });

    it('returns an empty list when the segment id does not resolve to a way', async () => {
      segmentRepo.query!.mockResolvedValueOnce([]);

      const result = await service.listForSegment('missing');

      expect(result).toEqual([]);
      expect(reviewRepo.find).not.toHaveBeenCalled();
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

    it('listForSegment only returns visible reviews', async () => {
      await service.listForSegment('seg-1');
      expect(reviewRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          where: expect.objectContaining({
            road_segment_id: In(['seg-1']),
            moderation_status: 'visible',
          }),
        }),
      );
    });

    it("surfaces the viewer's OWN review even when hidden (self-view exemption)", async () => {
      await service.listForSegment('seg-1', 'user-1');
      // Authenticated: visible-to-all OR the viewer's own rows (any status),
      // so a rider can still edit/delete their own moderated review.
      expect(reviewRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [
            { road_segment_id: In(['seg-1']), moderation_status: 'visible' },
            { road_segment_id: In(['seg-1']), user_id: 'user-1' },
          ],
        }),
      );
    });

    it('should mask user_display_name when the author has been soft-deleted', async () => {
      reviewRepo.find!.mockResolvedValueOnce([
        { ...mockReview, user: undefined } as unknown as RoadReview,
      ]);

      const result = await service.listForSegment('seg-1');

      // After US-62 GDPR deletion, both a missing relation and a
      // soft-deleted author flow through the same masked-name path.
      expect(result[0].user_display_name).toBe('Deleted user');
      // #335: user_id is masked alongside the display name so the review
      // card has nothing to link a profile route to for tombstoned authors.
      expect(result[0].user_id).toBeNull();
    });

    it('should mask user_display_name when the author is soft-deleted with deleted_at set', async () => {
      reviewRepo.find!.mockResolvedValueOnce([
        {
          ...mockReview,
          user: { ...mockReview.user, deleted_at: new Date() },
        },
      ]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].user_display_name).toBe('Deleted user');
      expect(result[0].user_id).toBeNull();
    });

    it('masks user_display_name + user_id when the author is private (#279 / #501)', async () => {
      // The author exists and is not soft-deleted, but their privacy
      // preference says `profile_visibility: 'private'`. The review row
      // stays so the road quality context is preserved, but the
      // identity gets a "Hidden rider" tombstone instead of the name.
      privateUserIds = new Set(['user-1']);

      const result = await service.listForSegment('seg-1');

      expect(result[0].user_display_name).toBe('Hidden rider');
      expect(result[0].user_id).toBeNull();
      // Other fields still surface so the segment retains its quality
      // context — privacy hides identity, not the review.
      expect(result[0].rating).toBe(4);
      expect(result[0].comment).toBe('Smooth asphalt, great ride!');
    });

    it('suppresses photos for private authors so the URL filename cannot leak the user id (#501 review)', async () => {
      // Codex review on PR #513 r3212896111: managed review photo
      // filenames embed `<segmentId>-<userId>-...`, so emitting the
      // URL for a masked author would leak the rider's UUID even
      // with `user_id` nulled. The toResponse mapper must suppress
      // `photos` whenever the author is masked.
      reviewRepo.find!.mockResolvedValueOnce([
        {
          ...mockReview,
          photos: [
            'https://app.tarmoto.test/road-review-photos/seg-1-user-1-1700000000000-abc.jpg',
          ],
        },
      ]);
      privateUserIds = new Set(['user-1']);

      const result = await service.listForSegment('seg-1');

      expect(result[0].user_display_name).toBe('Hidden rider');
      expect(result[0].photos).toBeNull();
    });

    it('keeps photos visible to the author themselves on the self-view path (#501 review)', async () => {
      // Self-view exemption — a private rider editing their own
      // review still sees their own attachments.
      reviewRepo.find!.mockResolvedValueOnce([
        {
          ...mockReview,
          photos: [
            'https://app.tarmoto.test/road-review-photos/seg-1-user-1-1700000000000-abc.jpg',
          ],
        },
      ]);
      privateUserIds = new Set(['user-1']);

      const result = await service.listForSegment('seg-1', 'user-1');

      expect(result[0].user_display_name).toBe('John Rider');
      expect(result[0].photos).toEqual([
        'https://app.tarmoto.test/road-review-photos/seg-1-user-1-1700000000000-abc.jpg',
      ]);
    });

    it('keeps the author visible for a non-private profile (#279 / #501)', async () => {
      privateUserIds = new Set();

      const result = await service.listForSegment('seg-1');

      expect(result[0].user_display_name).toBe('John Rider');
      expect(result[0].user_id).toBe('user-1');
    });

    it('fails closed when the privacy lookup fails closed in the shared helper (#501 review)', async () => {
      // The shared `PrivacyPreferencesService.loadPrivateUserIds`
      // owns the fail-closed try/catch (covered in its own spec) —
      // simulate the closed result here (every supplied id returned
      // as private) and assert the feed masks the whole list rather
      // than 500ing.
      privacy.loadPrivateUserIds.mockResolvedValueOnce(new Set(['user-1']));

      const result = await service.listForSegment('seg-1');

      expect(result).toHaveLength(1);
      expect(result[0].user_display_name).toBe('Hidden rider');
      expect(result[0].user_id).toBeNull();
      // The review row itself still surfaces — masking identity, not
      // hiding content.
      expect(result[0].rating).toBe(4);
    });

    it("keeps the viewer's own private review unmasked (#501 review)", async () => {
      // Codex + Cursor Bugbot review on PR #513: a private rider
      // viewing the segment must still see their OWN review with
      // their real name + user_id (matches the `create` / `update`
      // paths). The mask is about hiding identity from OTHER
      // riders, not from the rider themselves.
      privateUserIds = new Set(['user-1']);

      const result = await service.listForSegment('seg-1', 'user-1');

      expect(result[0].user_display_name).toBe('John Rider');
      expect(result[0].user_id).toBe('user-1');
      expect(result[0].is_mine).toBe(true);
    });

    it("still masks a private author's review for other viewers (#501 review)", async () => {
      // Symmetric guard for the self-view exemption — a different
      // viewer of the same private rider's review must still see
      // the masked tombstone.
      privateUserIds = new Set(['user-1']);

      const result = await service.listForSegment('seg-1', 'someone-else');

      expect(result[0].user_display_name).toBe('Hidden rider');
      expect(result[0].user_id).toBeNull();
      expect(result[0].is_mine).toBe(false);
    });

    describe('sys_poi_ratings off', () => {
      beforeEach(() => {
        featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      });

      it('returns [] without querying for an ANONYMOUS viewer', async () => {
        const result = await service.listForSegment('seg-1', null);

        expect(result).toEqual([]);
        expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
          'sys_poi_ratings',
        );
        // Nobody's content to protect — so no way resolution, no query at all.
        expect(segmentRepo.query).not.toHaveBeenCalled();
        expect(reviewRepo.find).not.toHaveBeenCalled();
      });

      it("returns ONLY the viewer's own review, so it stays deletable", async () => {
        // The list is the only place either client exposes edit/delete from.
        // Returning `[]` here leaves the rider's own published review
        // unremovable for the length of the incident.
        reviewRepo.find!.mockResolvedValueOnce([
          { ...mockReview, user_id: 'user-1', user: mockUser },
        ] as unknown as RoadReview[]);

        const result = await service.listForSegment('seg-1', 'user-1');

        expect(reviewRepo.find).toHaveBeenCalledWith({
          // No `moderation_status` filter and no other author: scoped to the
          // viewer alone.
          where: { road_segment_id: In(['seg-1']), user_id: 'user-1' },
          relations: ['user'],
          order: { created_at: 'DESC' },
        });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('review-1');
        expect(result[0].is_mine).toBe(true);
      });

      it('emits NEUTRAL vote fields, never the real aggregate', async () => {
        // The trap: falling through the normal pipeline would call
        // `aggregateVotes` and serialize the very counts this switch
        // neutralises everywhere else, turning the read into a way to
        // recover hidden vote data.
        const aggregate = jest.spyOn(
          service as unknown as { aggregateVotes: () => unknown },
          'aggregateVotes',
        );
        reviewRepo.find!.mockResolvedValueOnce([
          { ...mockReview, user_id: 'user-1', user: mockUser },
        ] as unknown as RoadReview[]);

        const result = await service.listForSegment('seg-1', 'user-1');

        expect(aggregate).not.toHaveBeenCalled();
        expect(result[0].helpful_count).toBe(0);
        expect(result[0].not_helpful_count).toBe(0);
        expect(result[0].my_vote).toBeNull();
      });

      it("does NOT return other riders' reviews", async () => {
        // The kill still has to hold: the community's reviews stay hidden.
        // The query is scoped by `user_id`, so this asserts the scoping rather
        // than a post-filter.
        reviewRepo.find!.mockResolvedValueOnce([]);

        const result = await service.listForSegment('seg-1', 'user-2');

        expect(reviewRepo.find).toHaveBeenCalledWith({
          where: { road_segment_id: In(['seg-1']), user_id: 'user-2' },
          relations: ['user'],
          order: { created_at: 'DESC' },
        });
        expect(result).toEqual([]);
      });

      it('returns [] for a signed-in viewer who has no review here', async () => {
        reviewRepo.find!.mockResolvedValueOnce([]);

        const result = await service.listForSegment('seg-1', 'user-1');

        expect(result).toEqual([]);
      });

      it('returns [] when the segment id does not resolve to a way', async () => {
        segmentRepo.query!.mockResolvedValueOnce([]);

        const result = await service.listForSegment('missing', 'user-1');

        expect(result).toEqual([]);
        expect(reviewRepo.find).not.toHaveBeenCalled();
      });
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
        where: { id: 'seg-1', deactivated_at: IsNull() },
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
      // only kicks in when the URL resolves to our managed namespace.
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

    it('throws 503 when sys_poi_ratings is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      await expect(
        service.create('user-1', 'seg-1', { rating: 5 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_poi_ratings',
      );
      // Gate is the first statement — no segment lookup, no write.
      expect(segmentRepo.findOne).not.toHaveBeenCalled();
      expect(reviewRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update an existing review', async () => {
      const dto = { rating: 2, comment: 'Road deteriorated' };

      const result = await service.update('user-1', 'seg-1', dto);

      // Resolves the rider's review anywhere on the requested id's way (#809).
      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-1', road_segment_id: In(['seg-1']) },
        relations: ['user'],
      });
      expect(reviewRepo.save).toHaveBeenCalled();
      expect(result.rating).toBe(2);
      expect(result.comment).toBe('Road deteriorated');
    });

    it("resolves the rider's review on a sibling sub-segment of the way (#809)", async () => {
      // The rider posted their review to sub-segment seg-2 (when it was the
      // representative); opening seg-1 of the same way must still find + edit it,
      // so the is_mine edit affordance doesn't 404.
      segmentRepo.query!.mockResolvedValueOnce([
        { id: 'seg-1' },
        { id: 'seg-2' },
      ]);
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        road_segment_id: 'seg-2',
      });

      await service.update('user-1', 'seg-1', { rating: 2 });

      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-1', road_segment_id: In(['seg-1', 'seg-2']) },
        relations: ['user'],
      });
      expect(reviewRepo.save).toHaveBeenCalled();
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
      // and now only keeps one must delete the storage object behind the
      // dropped URL — otherwise removing a photo from the UI leaves an
      // orphan that nothing will ever clean up before the S3 lifecycle
      // sweep lands. Photo basenames must carry the `<segmentId>-<userId>-`
      // prefix so the cascade-delete recognizes them as the caller's
      // own files.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-drop.jpg',
        ],
      });

      await service.update('user-1', 'seg-1', {
        rating: 4,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
        ],
      });

      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(
        'road-review-photos/seg-1-user-1-drop.jpg',
      );
    });

    it('should not delete anything when photos are unchanged', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-same.jpg',
        ],
      });

      await service.update('user-1', 'seg-1', {
        rating: 4,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-same.jpg',
        ],
      });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should ignore dropped third-party URLs that are not managed', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://cdn.example.com/foreign.jpg',
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-managed.jpg',
        ],
      });

      await service.update('user-1', 'seg-1', { rating: 4, photos: [] });

      // The foreign URL is left alone — we never wrote it, we don't own
      // the lifecycle for it. Only the managed file is removed.
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(
        'road-review-photos/seg-1-user-1-managed.jpg',
      );
    });

    it('should not delete keys for path-traversal attempts in stored photo URLs', async () => {
      // A row whose photos[] was crafted (or migrated from legacy data)
      // to include a `..%2F..%2F` segment must NOT cause storage.delete
      // to be called with anything that escapes the managed namespace.
      // The URL resolver returns null for those, mirroring the avatar
      // pattern.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/..%2F..%2Fsecrets.txt',
          'https://app.tarmoto.test/uploads/road-review-photos/%00pwn.jpg',
        ],
      });

      await service.update('user-1', 'seg-1', { rating: 4, photos: [] });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should not delete a managed file uploaded by another user', async () => {
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
      });

      await service.update('user-1', 'seg-1', { rating: 4, photos: [] });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it("should reject when the payload references another user's managed photo", async () => {
      // The DTO accepts any well-formed photo URL — without this guard,
      // user-1 could attach user-2's `/road-review-photos/...` URL to
      // their own review, and a later cascade-delete on user-1's review
      // would then remove user-2's file. The owner check at the
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
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should treat URLs from a third-party CDN with a colliding pathname as not managed', async () => {
      // A third-party origin like `cdn.example.com` happens to expose a
      // file at `/uploads/road-review-photos/<our-prefix>-x.jpg` — the
      // pathname-only resolver would have classified this as managed
      // and rejected with 400 even though the URL points at someone
      // else's server. The origin guard restricts "managed" detection
      // to the configured `TARMOTO_PUBLIC_BASE_URL` (or loopback in
      // dev) plus the configured storage origin, so a foreign CDN URL
      // passes through untouched as a third-party photo.
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
      expect(storage.delete).not.toHaveBeenCalled();
      expect(result.photos).toEqual([
        'https://cdn.example.com/uploads/road-review-photos/seg-1-other-user-shot.jpg',
      ]);
    });

    it('should treat a whitespace-padded stored URL and a trimmed update as the same photo', async () => {
      // `IsReviewPhotoUrl` validates `value.trim()`, so a row could land
      // in the DB with surrounding whitespace via direct API use. If the
      // set-difference compared raw strings, the next update sending the
      // same URL trimmed would mark it as removed and delete the file
      // out from under the still-saved (now-normalized) review row.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          '  https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg  ',
        ],
      });

      await service.update('user-1', 'seg-1', {
        rating: 4,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
        ],
      });

      expect(storage.delete).not.toHaveBeenCalled();
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

    it('throws 503 when sys_poi_ratings is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      await expect(
        service.update('user-1', 'seg-1', { rating: 2 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_poi_ratings',
      );
      // Gate is the first statement — no lookup, no write.
      expect(reviewRepo.findOne).not.toHaveBeenCalled();
      expect(reviewRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete an existing review', async () => {
      await service.delete('user-1', 'seg-1');

      // Resolves the rider's review anywhere on the requested id's way (#809).
      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-1', road_segment_id: In(['seg-1']) },
        relations: [],
      });
      expect(reviewRepo.remove).toHaveBeenCalledWith(mockReview);
    });

    it('should throw NotFoundException when review does not exist', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.delete('user-1', 'seg-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it("resolves the rider's review on a sibling sub-segment of the way (#809)", async () => {
      segmentRepo.query!.mockResolvedValueOnce([
        { id: 'seg-1' },
        { id: 'seg-2' },
      ]);
      const siblingReview = { ...mockReview, road_segment_id: 'seg-2' };
      reviewRepo.findOne!.mockResolvedValueOnce(siblingReview);

      await service.delete('user-1', 'seg-1');

      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: 'user-1', road_segment_id: In(['seg-1', 'seg-2']) },
        relations: [],
      });
      expect(reviewRepo.remove).toHaveBeenCalledWith(siblingReview);
    });

    it('should cascade-delete managed photo objects after removing the review', async () => {
      // Files referenced by the deleted review live under our managed
      // `road-review-photos/` storage prefix and must be deleted so the
      // user-driven delete actually frees space — third-party URLs are
      // left alone and missing keys are tolerated. Filenames must carry
      // the `<segmentId>-<userId>-` prefix to be recognized as the
      // caller's own.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-keep.jpg',
          'https://cdn.example.com/external.jpg', // not managed → skipped
        ],
      });

      await service.delete('user-1', 'seg-1');

      expect(reviewRepo.remove).toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(
        'road-review-photos/seg-1-user-1-keep.jpg',
      );
    });

    it("should not delete another user's managed photo even if the row points at it", async () => {
      // Same defense-in-depth as the update path: a legacy row that
      // somehow references user-2's filename must NOT cause storage.delete
      // when user-1 deletes their review. The cascade-delete is bound to
      // the caller's `<segmentId>-<userId>-` namespace, period.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-other-user-foreign.jpg',
        ],
      });

      await service.delete('user-1', 'seg-1');

      expect(reviewRepo.remove).toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should not call storage.delete when the review has no photos', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: null,
      });

      await service.delete('user-1', 'seg-1');

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('should swallow storage.delete errors after the row is already removed', async () => {
      // Cascade-delete is best-effort — the row is already gone, so a
      // transient storage hiccup (S3 5xx, FS permission blip) must not
      // turn the user-driven delete into a 500. Mirrors
      // `cleanupPreviousAvatar`. The next upload (or a future GC sweep)
      // reclaims the orphan.
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-missing.jpg',
        ],
      });
      storage.delete.mockRejectedValueOnce(new Error('transient S3 5xx'));
      // Silence the warn log so the test output stays clean — the
      // service intentionally logs at warn level but the assertion is
      // about the resolved Promise, not the log line.
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});

      await expect(service.delete('user-1', 'seg-1')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('still works when sys_poi_ratings is off (withdrawal always allowed)', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      await expect(service.delete('user-1', 'seg-1')).resolves.not.toThrow();

      expect(reviewRepo.remove).toHaveBeenCalledWith(mockReview);
      // Withdrawal is never gated — the switch isn't even consulted.
      expect(featureResolver.isSystemSwitchEnabled).not.toHaveBeenCalled();
    });
  });

  describe('adminHardDelete', () => {
    it('returns true, removes the row, and purges managed photos', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-admin-purge.jpg',
        ],
      });

      const result = await service.adminHardDelete('review-1');

      expect(result).toBe(true);
      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'review-1' },
      });
      expect(reviewRepo.remove).toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledWith(
        'road-review-photos/seg-1-user-1-admin-purge.jpg',
      );
    });

    it('returns false when the review is not found', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      const result = await service.adminHardDelete('nonexistent-id');

      expect(result).toBe(false);
      expect(reviewRepo.remove).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('does not purge photos when reviewRepo.remove rejects', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-should-stay.jpg',
        ],
      });
      reviewRepo.remove!.mockRejectedValueOnce(new Error('db constraint'));

      await expect(service.adminHardDelete('review-1')).rejects.toThrow(
        'db constraint',
      );

      expect(storage.delete).not.toHaveBeenCalled();
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
      expect(storage.put).not.toHaveBeenCalled();
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
      expect(storage.put).not.toHaveBeenCalled();
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
      // Validation runs over the whole batch before any storage write so
      // a bad file in the middle of a gallery doesn't leave a half-uploaded
      // mess in the bucket.
      expect(storage.put).not.toHaveBeenCalled();
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
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('should put each accepted file under road-review-photos/ and return absolute URLs lifted via publicBaseUrl (LocalStorage)', async () => {
      const result = await service.uploadPhotos(
        'user-1',
        'seg-1',
        [fileA, fileB],
        'https://app.tarmoto.test',
      );

      expect(storage.put).toHaveBeenCalledTimes(2);
      // Inspect the call args directly rather than via expect.stringMatching
      // inside objectContaining — the matcher returns `any` which the lint
      // rule (no-unsafe-assignment) trips on against `PutArgs.key: string`.
      const firstCall = storage.put.mock.calls[0][0];
      expect(firstCall.key).toMatch(
        /^road-review-photos\/seg-1-user-1-.*\.jpg$/,
      );
      expect(firstCall.body).toBe(fileA.buffer);
      expect(firstCall.contentType).toBe('image/jpeg');
      const secondCall = storage.put.mock.calls[1][0];
      expect(secondCall.key).toMatch(
        /^road-review-photos\/seg-1-user-1-.*\.webp$/,
      );
      expect(secondCall.body).toBe(fileB.buffer);
      expect(secondCall.contentType).toBe('image/webp');
      expect(result.photos).toHaveLength(2);
      // LocalStorage returned a relative `/uploads/<key>` URL; the
      // service must lift it to absolute via the controller-supplied
      // public base URL so mobile / web clients can fetch it directly.
      expect(result.photos[0]).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/road-review-photos\/seg-1-user-1-.*\.jpg$/,
      );
      expect(result.photos[1]).toMatch(
        /^https:\/\/app\.tarmoto\.test\/uploads\/road-review-photos\/seg-1-user-1-.*\.webp$/,
      );
    });

    it('should return absolute URLs verbatim when storage emits them (S3 / CDN)', async () => {
      // S3Storage.publicUrl() returns absolute CDN URLs already — the
      // service must NOT re-prefix them with publicBaseUrl, otherwise we'd
      // emit invalid URLs like `https://app.tarmoto.test/https://cdn.../`.
      await createService({
        publicUrl: jest
          .fn()
          .mockImplementation(
            (key: string) => `https://cdn.tarmoto.app/${key}`,
          ),
      });

      const result = await service.uploadPhotos(
        'user-1',
        'seg-1',
        [fileA],
        'https://app.tarmoto.test',
      );

      expect(result.photos).toHaveLength(1);
      expect(result.photos[0]).toMatch(
        /^https:\/\/cdn\.tarmoto\.app\/road-review-photos\/seg-1-user-1-.*\.jpg$/,
      );
    });

    it('should roll back already-written keys when a later put fails', async () => {
      storage.put
        .mockResolvedValueOnce({ byteSize: 12 })
        .mockRejectedValueOnce(new Error('storage backend down'));

      await expect(
        service.uploadPhotos(
          'user-1',
          'seg-1',
          [fileA, fileB],
          'https://app.tarmoto.test',
        ),
      ).rejects.toThrow('storage backend down');

      // The first object made it to storage before the second failed —
      // the rollback must delete it so callers either get every URL or
      // none. Anything else leaks storage on retry.
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(
        expect.stringMatching(/^road-review-photos\/seg-1-user-1-.*\.jpg$/),
      );
    });

    it('should swallow rollback delete errors so the original write error surfaces', async () => {
      storage.put
        .mockResolvedValueOnce({ byteSize: 12 })
        .mockRejectedValueOnce(new Error('storage backend down'));
      storage.delete.mockRejectedValueOnce(new Error('rollback also failed'));

      // The original `storage backend down` is what the caller cares
      // about — swallowing the rollback failure keeps that error visible.
      await expect(
        service.uploadPhotos(
          'user-1',
          'seg-1',
          [fileA, fileB],
          'https://app.tarmoto.test',
        ),
      ).rejects.toThrow('storage backend down');
    });

    it('throws 503 when sys_poi_ratings is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      await expect(
        service.uploadPhotos(
          'user-1',
          'seg-1',
          [fileA],
          'https://app.tarmoto.test',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_poi_ratings',
      );
      // Gate is the first statement — no segment lookup, no storage write.
      expect(segmentRepo.findOne).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });
  });

  describe('toResponse', () => {
    it('should format created_at as ISO string', async () => {
      const freshReview = {
        ...mockReview,
        created_at: new Date('2026-04-14T10:00:00Z'),
      };
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
        user_id: 'user-1',
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
      // / sanitizer reads NODE_ENV at call time so the prod
      // posture stays the same regardless of how the row landed there.
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
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
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = previous;
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

    it('rejects a vote on a hidden (moderated) review', async () => {
      // The lookup filters moderation_status='visible', so a hidden review
      // resolves to null → NotFound, and no vote is recorded.
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.castVote('viewer-1', 'review-2', true),
      ).rejects.toThrow(NotFoundException);
      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'review-2', moderation_status: 'visible' },
      });
      expect(voteInsert.execute).not.toHaveBeenCalled();
    });

    it('throws 503 when sys_poi_ratings is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      await expect(
        service.castVote('viewer-1', 'review-2', true),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_poi_ratings',
      );
      // Gate is the first statement — no lookup, no vote written.
      expect(reviewRepo.findOne).not.toHaveBeenCalled();
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

    it('rejects clearing a vote on a hidden (moderated) review', async () => {
      reviewRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.clearVote('viewer-1', 'review-2')).rejects.toThrow(
        NotFoundException,
      );
      expect(reviewRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'review-2', moderation_status: 'visible' },
      });
      expect(voteRepo.delete).not.toHaveBeenCalled();
    });

    it('retracts the vote but returns neutral counts when sys_poi_ratings is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);
      reviewRepo.findOne!.mockResolvedValueOnce({
        id: 'review-2',
        user_id: 'author-2',
      } as unknown as RoadReview);
      // Non-zero aggregate: if the switch-off path read it back, the result
      // would surface 3/1 and leak the hidden counts through this DELETE.
      voteGroupRows = [
        {
          road_review_id: 'review-2',
          helpful_count: 3,
          not_helpful_count: 1,
        },
      ];
      viewerVotes = [];

      const result = await service.clearVote('viewer-1', 'review-2');

      // The withdrawal still happens — a kill never traps user content...
      expect(voteRepo.delete).toHaveBeenCalledWith({
        user_id: 'viewer-1',
        road_review_id: 'review-2',
      });
      // ...but the aggregate is display data: skipped, neutral counts back,
      // so the DELETE can't be used to read the hidden vote counts.
      expect(result).toEqual({
        helpful_count: 0,
        not_helpful_count: 0,
        my_vote: null,
      });
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_poi_ratings',
      );
    });
  });

  describe('S3 / CDN trusted-origin extension', () => {
    it('treats the storage CDN origin as managed in the cascade-delete', async () => {
      // S3 deploys emit URLs anchored at the CDN origin (different from
      // `TARMOTO_PUBLIC_BASE_URL`). The service must extend its trusted
      // set with that origin so own-emitted URLs are recognized as
      // managed — otherwise the cascade-delete on update / delete would
      // silently no-op even though we own the keys.
      await createService({
        publicUrl: jest
          .fn()
          .mockImplementation(
            (key: string) => `https://cdn.tarmoto.app/${key}`,
          ),
      });
      reviewRepo.findOne!.mockResolvedValueOnce({
        ...mockReview,
        photos: [
          'https://cdn.tarmoto.app/road-review-photos/seg-1-user-1-x.jpg',
        ],
      });

      await service.delete('user-1', 'seg-1');

      expect(storage.delete).toHaveBeenCalledWith(
        'road-review-photos/seg-1-user-1-x.jpg',
      );
    });

    it('still rejects cross-user attaches when the URL uses the storage CDN origin', async () => {
      // The CDN origin is trusted, but the ownership filename-prefix
      // check still runs — user-1 cannot attach a CDN URL whose
      // filename belongs to user-2 just because the origin matches.
      await createService({
        publicUrl: jest
          .fn()
          .mockImplementation(
            (key: string) => `https://cdn.tarmoto.app/${key}`,
          ),
      });

      await expect(
        service.create('user-1', 'seg-1', {
          rating: 4,
          photos: [
            'https://cdn.tarmoto.app/road-review-photos/seg-1-other-user-shot.jpg',
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
