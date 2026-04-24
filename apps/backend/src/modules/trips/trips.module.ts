import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trip, TripMember, TripDay, TripWaypoint]),
  ],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
