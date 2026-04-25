import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity.js';
import { UserContact } from './entities/user-contact.entity.js';
import { RoadSegment } from './entities/road-segment.entity.js';
import { SurfaceReading } from './entities/surface-reading.entity.js';
import { Ride } from './entities/ride.entity.js';
import { RideSegment } from './entities/ride-segment.entity.js';
import { RideStats } from './entities/ride-stats.entity.js';
import { HazardReport } from './entities/hazard-report.entity.js';
import { RoadReview } from './entities/road-review.entity.js';
import { Trip } from './entities/trip.entity.js';
import { TripMember } from './entities/trip-member.entity.js';
import { TripDay } from './entities/trip-day.entity.js';
import { TripWaypoint } from './entities/trip-waypoint.entity.js';
import { FunZone } from './entities/fun-zone.entity.js';
import { FunZoneRoad } from './entities/fun-zone-road.entity.js';
import { CommuteRoute } from './entities/commute-route.entity.js';
import { SharedRide } from './entities/shared-ride.entity.js';
import { TripShare } from './entities/trip-share.entity.js';
import { TripSuggestion } from './entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from './entities/trip-suggestion-vote.entity.js';
import { TripMessage } from './entities/trip-message.entity.js';
import { TripActivity } from './entities/trip-activity.entity.js';
import { InitSchema1713000000000 } from './migrations/1713000000000-InitSchema.js';
import { AddPasswordHash1713100000000 } from './migrations/1713100000000-AddPasswordHash.js';
import { FixIsEmergencyDefault1713200000000 } from './migrations/1713200000000-FixIsEmergencyDefault.js';
import { AddUniqueActiveRide1713300000000 } from './migrations/1713300000000-AddUniqueActiveRide.js';
import { AddCommunityTables1713400000000 } from './migrations/1713400000000-AddCommunityTables.js';
import { AddRideAvgCurviness1714400000000 } from './migrations/1714400000000-AddRideAvgCurviness.js';
import { AddSharedRideViewCount1714300000000 } from './migrations/1714300000000-AddSharedRideViewCount.js';
import { AddSharedRideEmbedClickCount1714500000000 } from './migrations/1714500000000-AddSharedRideEmbedClickCount.js';
import { AddTripInviteCode1714800000000 } from './migrations/1714800000000-AddTripInviteCode.js';
import { AddTripShares1714900000000 } from './migrations/1714900000000-AddTripShares.js';
import { AddTripCollaboration1715000000000 } from './migrations/1715000000000-AddTripCollaboration.js';
import { AddTripActivity1715100000000 } from './migrations/1715100000000-AddTripActivity.js';
import { AddSurfaceReadingClientModelVersion1715200000000 } from './migrations/1715200000000-AddSurfaceReadingClientModelVersion.js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.TARMOTO_DATABASE_HOST || 'localhost',
  port: parseInt(process.env.TARMOTO_DATABASE_PORT || '5432', 10),
  database: process.env.TARMOTO_DATABASE_NAME || 'tarmoto',
  username: process.env.TARMOTO_DATABASE_USER || 'tarmoto',
  password: process.env.TARMOTO_DATABASE_PASSWORD || 'tarmoto',
  entities: [
    User,
    UserContact,
    RoadSegment,
    SurfaceReading,
    Ride,
    RideSegment,
    RideStats,
    HazardReport,
    RoadReview,
    Trip,
    TripMember,
    TripDay,
    TripWaypoint,
    FunZone,
    FunZoneRoad,
    CommuteRoute,
    SharedRide,
    TripShare,
    TripSuggestion,
    TripSuggestionVote,
    TripMessage,
    TripActivity,
  ],
  migrations: [
    InitSchema1713000000000,
    AddPasswordHash1713100000000,
    FixIsEmergencyDefault1713200000000,
    AddUniqueActiveRide1713300000000,
    AddCommunityTables1713400000000,
    AddSharedRideViewCount1714300000000,
    AddRideAvgCurviness1714400000000,
    AddSharedRideEmbedClickCount1714500000000,
    AddTripInviteCode1714800000000,
    AddTripShares1714900000000,
    AddTripCollaboration1715000000000,
    AddTripActivity1715100000000,
    AddSurfaceReadingClientModelVersion1715200000000,
  ],
  synchronize: false,
});
