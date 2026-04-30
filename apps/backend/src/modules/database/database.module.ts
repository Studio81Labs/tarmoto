import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { databaseConfig } from '../../config/database.config.js';
import { InitSchema1713000000000 } from '../../migrations/1713000000000-InitSchema.js';
import { AddPasswordHash1713100000000 } from '../../migrations/1713100000000-AddPasswordHash.js';
import { FixIsEmergencyDefault1713200000000 } from '../../migrations/1713200000000-FixIsEmergencyDefault.js';
import { AddUniqueActiveRide1713300000000 } from '../../migrations/1713300000000-AddUniqueActiveRide.js';
import { AddCommunityTables1713400000000 } from '../../migrations/1713400000000-AddCommunityTables.js';
import { AddChallengeTables1713500000000 } from '../../migrations/1713500000000-AddChallengeTables.js';
import { AddMountainPasses1713600000000 } from '../../migrations/1713600000000-AddMountainPasses.js';
import { AddRoadSegmentElevationProfile1713700000000 } from '../../migrations/1713700000000-AddRoadSegmentElevationProfile.js';
import { AddRideName1713800000000 } from '../../migrations/1713800000000-AddRideName.js';
import { AddUserProfileFields1713900000000 } from '../../migrations/1713900000000-AddUserProfileFields.js';
import { AddRoadReviewVotes1714000000000 } from '../../migrations/1714000000000-AddRoadReviewVotes.js';
import { AddRoadClosures1714100000000 } from '../../migrations/1714100000000-AddRoadClosures.js';
import { AddClosureDetourGeom1714200000000 } from '../../migrations/1714200000000-AddClosureDetourGeom.js';
import { AddSharedRideViewCount1714300000000 } from '../../migrations/1714300000000-AddSharedRideViewCount.js';
import { AddRideAvgCurviness1714400000000 } from '../../migrations/1714400000000-AddRideAvgCurviness.js';
import { AddSharedRideEmbedClickCount1714500000000 } from '../../migrations/1714500000000-AddSharedRideEmbedClickCount.js';
import { AddStripeBillingToUsers1714600000000 } from '../../migrations/1714600000000-AddStripeBillingToUsers.js';
import { RecencyWeightedRoadQualityAggregation1714700000000 } from '../../migrations/1714700000000-RecencyWeightedRoadQualityAggregation.js';
import { AddTripInviteCode1714800000000 } from '../../migrations/1714800000000-AddTripInviteCode.js';
import { AddTripShares1714900000000 } from '../../migrations/1714900000000-AddTripShares.js';
import { AddTripCollaboration1715000000000 } from '../../migrations/1715000000000-AddTripCollaboration.js';
import { AddTripActivity1715100000000 } from '../../migrations/1715100000000-AddTripActivity.js';
import { AddSurfaceReadingClientModelVersion1715200000000 } from '../../migrations/1715200000000-AddSurfaceReadingClientModelVersion.js';
import { AddFunZoneClusteringSeed1715300000000 } from '../../migrations/1715300000000-AddFunZoneClusteringSeed.js';
import { AddCrashAlerts1715400000000 } from '../../migrations/1715400000000-AddCrashAlerts.js';
import { AddAccountDeletion1715500000000 } from '../../migrations/1715500000000-AddAccountDeletion.js';
import { AddDataExportRequests1715600000000 } from '../../migrations/1715600000000-AddDataExportRequests.js';
import { AddEmailVerificationAndPasswordReset1715700000000 } from '../../migrations/1715700000000-AddEmailVerificationAndPasswordReset.js';
import { AddPasswordChangedAtAndUniqueResetToken1715800000000 } from '../../migrations/1715800000000-AddPasswordChangedAtAndUniqueResetToken.js';
import { AddVerificationTokenUniqueIndex1715900000000 } from '../../migrations/1715900000000-AddVerificationTokenUniqueIndex.js';
import {
  User,
  UserContact,
  EmailVerificationToken,
  PasswordResetToken,
  AccountDeletionLog,
  CrashAlert,
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
  UserFollow,
  UserBadge,
  Challenge,
  ChallengeEntry,
  MountainPass,
  RoadReviewVote,
  RoadClosure,
  DataExportRequest,
} from '../../entities/index.js';

const entities = [
  User,
  UserContact,
  EmailVerificationToken,
  PasswordResetToken,
  AccountDeletionLog,
  CrashAlert,
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
  UserFollow,
  UserBadge,
  Challenge,
  ChallengeEntry,
  MountainPass,
  RoadReviewVote,
  RoadClosure,
  DataExportRequest,
];

@Module({
  imports: [
    ConfigModule.forFeature(databaseConfig),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isOpenApiExport = process.env['OPENAPI_EXPORT'] === 'true';
        return {
          type: 'postgres',
          host: config.get('database.host'),
          port: config.get('database.port'),
          database: config.get('database.database'),
          username: config.get('database.username'),
          password: config.get('database.password'),
          entities,
          migrations: [
            // Listed in chronological order. Every migration in
            // `src/migrations/` MUST be registered here so the runtime
            // `migrationsRun: true` path replays the full chain on a
            // fresh DB. Keep in sync with `data-source.ts` — drift
            // between the two would silently leave runtime DBs short
            // of schema changes that the CLI applies.
            InitSchema1713000000000,
            AddPasswordHash1713100000000,
            FixIsEmergencyDefault1713200000000,
            AddUniqueActiveRide1713300000000,
            AddCommunityTables1713400000000,
            AddChallengeTables1713500000000,
            AddMountainPasses1713600000000,
            AddRoadSegmentElevationProfile1713700000000,
            AddRideName1713800000000,
            AddUserProfileFields1713900000000,
            AddRoadReviewVotes1714000000000,
            AddRoadClosures1714100000000,
            AddClosureDetourGeom1714200000000,
            AddSharedRideViewCount1714300000000,
            AddRideAvgCurviness1714400000000,
            AddSharedRideEmbedClickCount1714500000000,
            AddStripeBillingToUsers1714600000000,
            RecencyWeightedRoadQualityAggregation1714700000000,
            AddTripInviteCode1714800000000,
            AddTripShares1714900000000,
            AddTripCollaboration1715000000000,
            AddTripActivity1715100000000,
            AddSurfaceReadingClientModelVersion1715200000000,
            AddFunZoneClusteringSeed1715300000000,
            AddCrashAlerts1715400000000,
            AddAccountDeletion1715500000000,
            AddDataExportRequests1715600000000,
            AddEmailVerificationAndPasswordReset1715700000000,
            AddPasswordChangedAtAndUniqueResetToken1715800000000,
            AddVerificationTokenUniqueIndex1715900000000,
          ],
          // During OpenAPI spec export we don't need a real DB connection.
          // Disable retries and migrations so bootstrap completes without a DB.
          migrationsRun: !isOpenApiExport,
          synchronize: false,
          retryAttempts: isOpenApiExport ? 0 : 10,
          logging:
            config.get('TARMOTO_NODE_ENV') === 'development'
              ? ['error', 'warn', 'migration']
              : ['error'],
        };
      },
    }),
  ],
})
export class DatabaseModule {}
