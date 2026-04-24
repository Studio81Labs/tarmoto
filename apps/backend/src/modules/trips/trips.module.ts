import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from '../../entities/trip-suggestion-vote.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { EventsModule } from '../events/events.module.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';
import { TripCollabController } from './trip-collab.controller.js';
import { TripCollabService } from './trip-collab.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trip,
      TripMember,
      TripDay,
      TripWaypoint,
      TripSuggestion,
      TripSuggestionVote,
      TripMessage,
    ]),
    EventsModule,
  ],
  controllers: [TripsController, TripCollabController],
  providers: [TripsService, TripCollabService],
  exports: [TripsService, TripCollabService],
})
export class TripsModule {}
