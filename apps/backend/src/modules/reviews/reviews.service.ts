import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { CreateReviewDto } from './dto/review.dto.js';
import { ReviewResponseDto } from './dto/review.dto.js';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(RoadReview)
    private readonly reviewRepo: Repository<RoadReview>,
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
  ) {}

  async listForSegment(segmentId: string): Promise<ReviewResponseDto[]> {
    const reviews = await this.reviewRepo.find({
      where: { road_segment_id: segmentId },
      relations: ['user'],
      order: { created_at: 'DESC' },
    });
    return reviews.map((r) => this.toResponse(r));
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

    const review = this.reviewRepo.create({
      user_id: userId,
      road_segment_id: segmentId,
      rating: dto.rating,
      comment: dto.comment ?? null,
      bike_model: dto.bike_model ?? null,
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

    return this.toResponse(full!);
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

    review.rating = dto.rating;
    review.comment = dto.comment ?? null;
    review.bike_model = dto.bike_model ?? null;

    const saved = await this.reviewRepo.save(review);
    return this.toResponse(saved);
  }

  async delete(userId: string, segmentId: string): Promise<void> {
    const review = await this.reviewRepo.findOne({
      where: { user_id: userId, road_segment_id: segmentId },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    await this.reviewRepo.remove(review);
  }

  private toResponse(review: RoadReview): ReviewResponseDto {
    return {
      id: review.id,
      user_display_name: review.user?.display_name ?? 'Unknown',
      rating: review.rating,
      comment: review.comment,
      bike_model: review.bike_model,
      created_at: review.created_at.toISOString(),
    };
  }
}
