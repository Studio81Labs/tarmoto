/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
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
    created_at: '2026-04-14T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      listForSegment: jest.fn().mockResolvedValue([mockReview]),
      create: jest.fn().mockResolvedValue(mockReview),
      update: jest.fn().mockResolvedValue(mockReview),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [
        { provide: ReviewsService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();

    controller = module.get<ReviewsController>(ReviewsController);
    service = module.get(ReviewsService);
  });

  it('GET /roads/:segmentId/reviews should list reviews', async () => {
    const result = await controller.list('seg-1');

    expect(service.listForSegment).toHaveBeenCalledWith('seg-1');
    expect(result).toHaveLength(1);
    expect(result[0].rating).toBe(4);
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
