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
