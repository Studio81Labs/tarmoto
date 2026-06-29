import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { FeatureFlag } from '../../entities/feature-flag.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import type { AdminMetricsDto } from './dto/admin-metrics.dto.js';

@Injectable()
export class AdminMetricsService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RoadClosure)
    private readonly closures: Repository<RoadClosure>,
    @InjectRepository(Ride)
    private readonly rides: Repository<Ride>,
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
    @InjectRepository(HazardReport)
    private readonly hazards: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    private readonly reviews: Repository<RoadReview>,
    @InjectRepository(TripMessage)
    private readonly messages: Repository<TripMessage>,
  ) {}

  async snapshot(): Promise<AdminMetricsDto> {
    const [
      users,
      closures,
      activeRides,
      featureFlags,
      hiddenHazards,
      hiddenReviews,
      hiddenMessages,
    ] = await Promise.all([
      this.users.count({ where: { deleted_at: IsNull() } }),
      this.closures.count(),
      this.rides.count({ where: { status: 'active' } }),
      this.flags.count(),
      this.hazards.count({ where: { moderation_status: 'hidden' } }),
      this.reviews.count({ where: { moderation_status: 'hidden' } }),
      this.messages.count({ where: { moderation_status: 'hidden' } }),
    ]);
    return {
      users,
      activeRides,
      featureFlags,
      closures,
      hiddenContent: hiddenHazards + hiddenReviews + hiddenMessages,
    };
  }
}
