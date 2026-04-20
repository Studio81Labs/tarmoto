/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ReviewsService } from './reviews.service.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let reviewRepo: Partial<jest.Mocked<Repository<RoadReview>>>;
  let segmentRepo: Partial<jest.Mocked<Repository<RoadSegment>>>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getRepositoryToken(RoadReview), useValue: reviewRepo },
        { provide: getRepositoryToken(RoadSegment), useValue: segmentRepo },
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
    });

    it('should return empty array when no reviews', async () => {
      reviewRepo.find!.mockResolvedValueOnce([]);

      const result = await service.listForSegment('seg-1');

      expect(result).toHaveLength(0);
    });

    it('should default user_display_name to Unknown when user is null', async () => {
      reviewRepo.find!.mockResolvedValueOnce([
        { ...mockReview, user: undefined } as unknown as RoadReview,
      ]);

      const result = await service.listForSegment('seg-1');

      expect(result[0].user_display_name).toBe('Unknown');
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
        '  https://padded.tarmoto.app/ok.jpg  ',
        'https://good.tarmoto.app/ok.jpg',
      ]);
    });
  });
});
