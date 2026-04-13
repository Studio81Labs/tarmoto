import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { databaseConfig } from '../../config/database.config.js';
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
        synchronize: false,
        logging:
          config.get('TARMOTO_NODE_ENV') === 'development'
            ? ['error', 'warn']
            : ['error'],
      }),
    }),
  ],
})
export class DatabaseModule {}
