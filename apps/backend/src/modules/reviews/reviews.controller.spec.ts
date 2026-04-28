/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

describe('ReviewsController', () => {
  let controller: ReviewsController;
  let service: jest.Mocked<ReviewsService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockReview = {
    id: 'review-1',
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [
        { provide: ReviewsService, useValue: mockService },
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
    expect(result[0].rating).toBe(4);
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
});
