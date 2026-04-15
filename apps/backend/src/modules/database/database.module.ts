import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { databaseConfig } from '../../config/database.config.js';
import { InitSchema1713000000000 } from '../../migrations/1713000000000-InitSchema.js';
import { AddPasswordHash1713100000000 } from '../../migrations/1713100000000-AddPasswordHash.js';
import { FixIsEmergencyDefault1713200000000 } from '../../migrations/1713200000000-FixIsEmergencyDefault.js';
import { AddUniqueActiveRide1713300000000 } from '../../migrations/1713300000000-AddUniqueActiveRide.js';
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
];

@Module({
  imports: [
    ConfigModule.forFeature(databaseConfig),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
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
        ],
        migrationsRun: true,
        synchronize: false,
        logging:
          config.get('TARMOTO_NODE_ENV') === 'development'
            ? ['error', 'warn', 'migration']
            : ['error'],
      }),
    }),
  ],
})
export class DatabaseModule {}
