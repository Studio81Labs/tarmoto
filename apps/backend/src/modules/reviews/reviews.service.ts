import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadReviewVote } from '../../entities/road-review-vote.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import {
  CreateReviewDto,
  ReviewResponseDto,
  ReviewVoteResultDto,
  sanitizeReviewPhotos,
} from './dto/review.dto.js';

interface VoteAggregate {
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
}

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(RoadReview)
    private readonly reviewRepo: Repository<RoadReview>,
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
    @InjectRepository(RoadReviewVote)
    private readonly voteRepo: Repository<RoadReviewVote>,
  ) {}

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

    const review = this.reviewRepo.create({
      user_id: userId,
      road_segment_id: segmentId,
      rating: dto.rating,
      comment: dto.comment ?? null,
      bike_model: dto.bike_model ?? null,
      photos: dto.photos ?? null,
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

    review.rating = dto.rating;
    review.comment = dto.comment ?? null;
    review.bike_model = dto.bike_model ?? null;
    review.photos = dto.photos ?? null;

    const saved = await this.reviewRepo.save(review);
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
    await this.reviewRepo.remove(review);
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
    return {
      id: review.id,
      user_display_name: review.user?.display_name ?? 'Unknown',
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
