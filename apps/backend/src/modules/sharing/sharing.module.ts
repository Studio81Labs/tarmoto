import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { RideLike } from '../../entities/ride-like.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { User } from '../../entities/user.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { AccountModule } from '../account/index.js';
import { TripsModule } from '../trips/trips.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { SharingController } from './sharing.controller.js';
import { SharingService } from './sharing.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SharedRide,
      RideLike,
      Ride,
      User,
      Trip,
      TripDay,
      TripMember,
    ]),
    AccountModule,
    // Reuse TripsService.withTripTransaction for the atomic trip+membership
    // +day commit when cloning a community ride into a trip.
    TripsModule,
    FeaturesModule,
  ],
  controllers: [SharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
