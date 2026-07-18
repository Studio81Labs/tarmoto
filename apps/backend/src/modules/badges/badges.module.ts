import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { BadgesController } from './badges.controller.js';
import { BadgesService } from './badges.service.js';
import { FeaturesModule } from '../features/features.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserBadge,
      Ride,
      RideSegment,
      HazardReport,
      RoadReview,
      SharedRide,
    ]),
    FeaturesModule,
  ],
  controllers: [BadgesController],
  providers: [BadgesService],
  exports: [BadgesService],
})
export class BadgesModule {}
