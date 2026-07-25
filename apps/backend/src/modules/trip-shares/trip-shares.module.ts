import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripShare } from '../../entities/trip-share.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { User } from '../../entities/user.entity.js';
import { TripActivityModule } from '../trip-activity/index.js';
import { FeaturesModule } from '../features/features.module.js';
import { TripSharesController } from './trip-shares.controller.js';
import { TripSharesService } from './trip-shares.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripShare, Trip, TripMember, TripInvite, User]),
    TripActivityModule,
    // FeatureResolver (exported by FeaturesModule) backs the owner-scoped
    // max_trip_collaborators cap on the group-link join path.
    FeaturesModule,
  ],
  controllers: [TripSharesController],
  providers: [TripSharesService],
  exports: [TripSharesService],
})
export class TripSharesModule {}
