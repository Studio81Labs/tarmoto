import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { SystemSwitchGuard } from '../features/system-switch.guard.js';
import { REQUIRED_SYSTEM_SWITCH_KEY } from '../features/require-system-switch.decorator.js';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

describe('ReviewsController', () => {
  let controller: ReviewsController;
  let service: jest.Mocked<ReviewsService>;
  let configGet: jest.Mock;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockReview = {
    id: 'review-1',
    user_id: 'user-1',
    user_display_name: 'John Rider',
    rating: 4,
    comment: 'Smooth asphalt, great ride!',
    bike_model: 'BMW R1250GS',
    photos: [],
    created_at: '2026-04-14T10:00:00.000Z',
    helpful_count: 0,
    not_helpful_count: 0,
    my_vote: null,
    is_mine: true,
  };

  beforeEach(async () => {
    const mockService = {
      listForSegment: jest.fn().mockResolvedValue([mockReview]),
      create: jest.fn().mockResolvedValue(mockReview),
      update: jest.fn().mockResolvedValue(mockReview),
      delete: jest.fn().mockResolvedValue(undefined),
      uploadPhotos: jest.fn().mockResolvedValue({
        photos: [
          'https://app.tarmoto.test/uploads/road-review-photos/seg-1-user-1-1.jpg',
        ],
      }),
      castVote: jest.fn().mockResolvedValue({
        helpful_count: 1,
        not_helpful_count: 0,
        my_vote: true,
      }),
      clearVote: jest.fn().mockResolvedValue({
        helpful_count: 0,
        not_helpful_count: 0,
        my_vote: null,
      }),
      listMyVotes: jest.fn().mockResolvedValue([
        {
          review_id: 'review-2',
          is_helpful: true,
          voted_at: '2026-08-01T09:30:00.000Z',
          road_segment_id: 'seg-9',
          road_name: 'Passo dello Stelvio',
          road_number: 'SS38',
        },
      ]),
    };

    configGet = jest.fn().mockReturnValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [
        { provide: ReviewsService, useValue: mockService },
        { provide: ConfigService, useValue: { get: configGet } },
        // `SystemSwitchGuard` on the photo route is instantiated by Nest DI
        // when the controller joins the module (its `canActivate` isn't
        // exercised by these direct method calls), so its `FeatureResolver`
        // dependency must resolve.
        {
          provide: FeatureResolver,
          useValue: {
            isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
          },
        },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<ReviewsController>(ReviewsController);
    service = module.get(ReviewsService);
  });

  it('GET /roads/:segmentId/reviews should list reviews anonymously', async () => {
    const anonReq = {} as never;
    const result = await controller.list(anonReq, 'seg-1');

    expect(service.listForSegment).toHaveBeenCalledWith('seg-1', null);
    expect(result).toHaveLength(1);
    expect(result[0]!.rating).toBe(4);
  });

  it('GET /roads/:segmentId/reviews should pass viewer id when authenticated', async () => {
    await controller.list(mockReq, 'seg-1');

    expect(service.listForSegment).toHaveBeenCalledWith('seg-1', 'user-1');
  });

  it('POST /roads/reviews/:reviewId/vote should cast a helpful vote', async () => {
    const result = await controller.vote(mockReq, 'review-1', {
      is_helpful: true,
    });

    expect(service.castVote).toHaveBeenCalledWith('user-1', 'review-1', true);
    expect(result.helpful_count).toBe(1);
    expect(result.my_vote).toBe(true);
  });

  it('DELETE /roads/reviews/:reviewId/vote should clear a vote', async () => {
    const result = await controller.clearVote(mockReq, 'review-1');

    expect(service.clearVote).toHaveBeenCalledWith('user-1', 'review-1');
    expect(result.my_vote).toBeNull();
  });

  it("GET /roads/reviews/votes/mine should list the caller's own votes", async () => {
    const result = await controller.listMyVotes(mockReq);

    expect(service.listMyVotes).toHaveBeenCalledWith('user-1');
    expect(result).toEqual([
      {
        review_id: 'review-2',
        is_helpful: true,
        voted_at: '2026-08-01T09:30:00.000Z',
        road_segment_id: 'seg-9',
        road_name: 'Passo dello Stelvio',
        road_number: 'SS38',
      },
    ]);
  });

  // #1177: this route is the discovery path for the withdrawal DELETE, which
  // deliberately stays open while `sys_poi_ratings` is off. Lock the wiring:
  // authenticated, but NO system-switch guard and NO switch metadata — adding
  // either would 503 the listing during a pause and re-trap the votes.
  it('GET /roads/reviews/votes/mine requires auth but is NOT gated by a system switch', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      ReviewsController.prototype.listMyVotes,
    ) as unknown[];
    expect(guards).toContain(AuthGuard);
    expect(guards).not.toContain(SystemSwitchGuard);

    const switchKey = Reflect.getMetadata(
      REQUIRED_SYSTEM_SWITCH_KEY,
      ReviewsController.prototype.listMyVotes,
    ) as string | undefined;
    expect(switchKey).toBeUndefined();
  });

  it('POST /roads/:segmentId/reviews should create review', async () => {
    const dto = { rating: 5, comment: 'Amazing road!' };

    const result = await controller.create(mockReq, 'seg-1', dto);

    expect(service.create).toHaveBeenCalledWith('user-1', 'seg-1', dto);
    expect(result.id).toBe('review-1');
  });

  it('PUT /roads/:segmentId/reviews should update review', async () => {
    const dto = { rating: 2, comment: 'Road deteriorated' };

    await controller.update(mockReq, 'seg-1', dto);

    expect(service.update).toHaveBeenCalledWith('user-1', 'seg-1', dto);
  });

  it('DELETE /roads/:segmentId/reviews should delete review', async () => {
    await controller.delete(mockReq, 'seg-1');

    expect(service.delete).toHaveBeenCalledWith('user-1', 'seg-1');
  });

  it('POST /roads/:segmentId/reviews/photos should prefer TARMOTO_PUBLIC_BASE_URL over the request-derived host', async () => {
    // In a TLS-terminating-proxy production deploy, `req.protocol` is
    // `http` (no `trust proxy` hops set by default), so deriving the
    // public URL from the request would produce http URLs that the
    // production CreateReviewDto then rejects. The configured value is
    // the source of truth — same env var the data-export service uses.
    configGet.mockImplementation((key: string) =>
      key === 'TARMOTO_PUBLIC_BASE_URL' ? 'https://api.tarmoto.app' : undefined,
    );
    const file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('jpg'),
    } as Express.Multer.File;
    const req = {
      user: { userId: 'user-1' },
      protocol: 'http', // simulates TLS terminator + trust_proxy=0
      get: jest.fn().mockReturnValue('internal.tarmoto.svc'),
    } as never;

    await controller.uploadPhotos(req, 'seg-1', [file]);

    expect(service.uploadPhotos).toHaveBeenCalledWith(
      'user-1',
      'seg-1',
      [file],
      'https://api.tarmoto.app',
    );
  });

  it('POST /roads/:segmentId/reviews/photos should fall back to the request-derived host when TARMOTO_PUBLIC_BASE_URL is unset', async () => {
    // Local-dev path: no env var, the API serves over plain http on
    // localhost, and `isAllowedReviewPhotoUrl` accepts loopback http
    // outside production so the round-trip works.
    configGet.mockReturnValue(undefined);
    const file = {
      mimetype: 'image/jpeg',
      buffer: Buffer.from('jpg'),
    } as Express.Multer.File;
    const req = {
      user: { userId: 'user-1' },
      protocol: 'http',
      get: jest.fn().mockReturnValue('localhost:3000'),
    } as never;

    await controller.uploadPhotos(req, 'seg-1', [file]);

    expect(service.uploadPhotos).toHaveBeenCalledWith(
      'user-1',
      'seg-1',
      [file],
      'http://localhost:3000',
    );
  });

  it('POST /roads/:segmentId/reviews/photos should 500 in production when TARMOTO_PUBLIC_BASE_URL is unset', async () => {
    // Production deploys MUST set TARMOTO_PUBLIC_BASE_URL — without it,
    // the service's trusted-origin set is empty and any URL the upload
    // emits via `req.protocol://req.get('host')` would be classified as
    // third-party at submission time, silently bypassing the ownership
    // guard and leaving managed files orphaned. Fail fast.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    configGet.mockReturnValue(undefined);
    try {
      const file = {
        mimetype: 'image/jpeg',
        buffer: Buffer.from('jpg'),
      } as Express.Multer.File;
      const req = {
        user: { userId: 'user-1' },
        protocol: 'https',
        get: jest.fn().mockReturnValue('api.example.com'),
      } as never;

      await expect(
        controller.uploadPhotos(req, 'seg-1', [file]),
      ).rejects.toThrow(InternalServerErrorException);
      expect(service.uploadPhotos).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });

  it('POST /roads/:segmentId/reviews/photos should 500 in production when TARMOTO_PUBLIC_BASE_URL is non-https', async () => {
    // Bad config (e.g. operator typo) where the env var resolves to an
    // http URL in prod — same outcome as missing config: the service
    // would never trust the resulting origin. Fail fast with a 500.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    configGet.mockImplementation((key: string) =>
      key === 'TARMOTO_PUBLIC_BASE_URL' ? 'http://api.example.com' : undefined,
    );
    try {
      const file = {
        mimetype: 'image/jpeg',
        buffer: Buffer.from('jpg'),
      } as Express.Multer.File;
      const req = {
        user: { userId: 'user-1' },
        protocol: 'https',
        get: jest.fn().mockReturnValue('api.example.com'),
      } as never;

      await expect(
        controller.uploadPhotos(req, 'seg-1', [file]),
      ).rejects.toThrow(InternalServerErrorException);
      expect(service.uploadPhotos).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });

  it('POST /roads/:segmentId/reviews/photos should accept a properly-configured production deploy', async () => {
    // Counterpoint to the misconfig tests: with a valid https
    // TARMOTO_PUBLIC_BASE_URL set, production uploads go through and
    // the service is called with the configured origin (which the
    // service will then recognize as managed in `resolveManagedReviewPhoto`).
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    configGet.mockImplementation((key: string) =>
      key === 'TARMOTO_PUBLIC_BASE_URL' ? 'https://api.tarmoto.app' : undefined,
    );
    try {
      const file = {
        mimetype: 'image/jpeg',
        buffer: Buffer.from('jpg'),
      } as Express.Multer.File;
      const req = {
        user: { userId: 'user-1' },
        protocol: 'http',
        get: jest.fn().mockReturnValue('internal.tarmoto.svc'),
      } as never;

      await controller.uploadPhotos(req, 'seg-1', [file]);

      expect(service.uploadPhotos).toHaveBeenCalledWith(
        'user-1',
        'seg-1',
        [file],
        'https://api.tarmoto.app',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });

  it('POST /roads/:segmentId/reviews/photos should reject when no files were uploaded', async () => {
    // Multer hands us undefined when the multipart form has no `files`
    // entries; the controller has to surface a 400 itself because the
    // service-level zero-length guard never gets a chance to run.
    const req = {
      user: { userId: 'user-1' },
      protocol: 'https',
      get: jest.fn().mockReturnValue('app.tarmoto.test'),
    } as never;

    await expect(
      controller.uploadPhotos(req, 'seg-1', undefined),
    ).rejects.toThrow(BadRequestException);
    expect(service.uploadPhotos).not.toHaveBeenCalled();
  });

  // The photo route buffers a multipart payload via `FilesInterceptor`.
  // Guards run in the guard phase, BEFORE interceptors, so gating the route
  // with `SystemSwitchGuard` (not just the service) is what lets the
  // `sys_poi_ratings` kill switch reject with 503 before Multer parses and
  // buffers uploads — the load it has to shed during a photo-spam incident.
  // These lock that wiring so it can't silently regress to a service-only gate.
  it('POST /roads/:segmentId/reviews/photos authenticates before the system-switch lookup (still pre-Multer)', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      ReviewsController.prototype.uploadPhotos,
    ) as unknown[];
    expect(guards).toBeDefined();
    expect(guards).toContain(SystemSwitchGuard);
    // AuthGuard first: an anonymous request is 401'd without the switch
    // guard's feature_states read / state leak. SystemSwitchGuard still runs
    // in the guard phase (before FilesInterceptor), so a killed feature is
    // 503'd before Multer buffers the payload for an authenticated upload.
    expect(guards[0]).toBe(AuthGuard);
    expect(guards).toContain(SystemSwitchGuard);
  });

  it('POST /roads/:segmentId/reviews/photos declares the sys_poi_ratings switch', () => {
    const key = Reflect.getMetadata(
      REQUIRED_SYSTEM_SWITCH_KEY,
      ReviewsController.prototype.uploadPhotos,
    ) as string | undefined;
    expect(key).toBe('sys_poi_ratings');
  });
});
