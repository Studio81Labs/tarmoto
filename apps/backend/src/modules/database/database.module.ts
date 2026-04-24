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
import { AddRoadReviewVotes1714000000000 } from '../../migrations/1714000000000-AddRoadReviewVotes.js';
import { AddRoadClosures1714100000000 } from '../../migrations/1714100000000-AddRoadClosures.js';
import { AddClosureDetourGeom1714200000000 } from '../../migrations/1714200000000-AddClosureDetourGeom.js';
import { AddSharedRideViewCount1714300000000 } from '../../migrations/1714300000000-AddSharedRideViewCount.js';
import { AddRideAvgCurviness1714400000000 } from '../../migrations/1714400000000-AddRideAvgCurviness.js';
import { AddSharedRideEmbedClickCount1714500000000 } from '../../migrations/1714500000000-AddSharedRideEmbedClickCount.js';
import { AddStripeBillingToUsers1714600000000 } from '../../migrations/1714600000000-AddStripeBillingToUsers.js';
import { AddTripInviteCode1714800000000 } from '../../migrations/1714800000000-AddTripInviteCode.js';
import {
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
  UserFollow,
  UserBadge,
  Challenge,
  ChallengeEntry,
  MountainPass,
  RoadReviewVote,
  RoadClosure,
} from '../../entities/index.js';

const entities = [
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
  UserFollow,
  UserBadge,
  Challenge,
  ChallengeEntry,
  MountainPass,
  RoadReviewVote,
  RoadClosure,
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
            InitSchema1713000000000,
            AddPasswordHash1713100000000,
            FixIsEmergencyDefault1713200000000,
            AddUniqueActiveRide1713300000000,
            AddCommunityTables1713400000000,
            AddChallengeTables1713500000000,
            AddMountainPasses1713600000000,
            AddRoadReviewVotes1714000000000,
            AddRoadClosures1714100000000,
            AddClosureDetourGeom1714200000000,
            AddSharedRideViewCount1714300000000,
            AddRideAvgCurviness1714400000000,
            AddSharedRideEmbedClickCount1714500000000,
            AddStripeBillingToUsers1714600000000,
            AddTripInviteCode1714800000000,
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
