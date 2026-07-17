import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../../entities/trip.entity.js';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import { TripSuggestion } from '../../entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from '../../entities/trip-suggestion-vote.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { TripInvite } from '../../entities/trip-invite.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { User } from '../../entities/user.entity.js';
import { CommuteModule } from '../commute/index.js';
import { EmailModule } from '../email/email.module.js';
import { EventsModule } from '../events/events.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { TripActivityModule } from '../trip-activity/index.js';
import { TripSharesModule } from '../trip-shares/trip-shares.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ClosuresModule } from '../closures/index.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';
import { TripGeneratorService } from './trip-generator.service.js';
import { TripCollabController } from './trip-collab.controller.js';
import { TripCollabService } from './trip-collab.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trip,
      TripFolder,
      TripMember,
      TripDay,
      TripWaypoint,
      TripSuggestion,
      TripSuggestionVote,
      TripMessage,
      TripInvite,
      RoadSegment,
      User,
    ]),
    ConfigModule,
    EmailModule,
    EventsModule,
    // FeaturesModule exports FeatureResolver so trip creation, import,
    // duplication, and reopen-via-update can gate against the caller's
    // (or owner's) `max_active_trips` entitlement.
    FeaturesModule,
    TripActivityModule,
    // TripSharesModule re-exports TripSharesService so trip member removal
    // can revoke the departing member's outstanding share links
    // (`revokeAllForTripMember`).
    TripSharesModule,
    // CommuteModule re-exports ROUTING_PROVIDER so the trip generator
    // can reuse the configured OSRM (or other) routing engine without
    // re-registering the provider here.
    CommuteModule,
    // RoutingModule owns RouteEnrichmentService as the single instance;
    // importing it here makes the export available to TripGeneratorService.
    RoutingModule,
    // ClosuresModule exports ClosuresService so the generator can route
    // around active full closures (#744).
    ClosuresModule,
  ],
  controllers: [TripsController, TripCollabController],
  providers: [TripsService, TripGeneratorService, TripCollabService],
  exports: [TripsService, TripGeneratorService, TripCollabService],
})
export class TripsModule {}
