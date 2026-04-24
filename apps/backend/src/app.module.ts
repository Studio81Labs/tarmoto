import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { AuthModule } from './modules/auth/index.js';
import { HazardsModule } from './modules/hazards/index.js';
import { SensorModule } from './modules/sensor/index.js';
import { RoadsModule } from './modules/roads/index.js';
import { UsersModule } from './modules/users/index.js';
import { RidesModule } from './modules/rides/index.js';
import { EventsModule } from './modules/events/index.js';
import { SafetyModule } from './modules/safety/index.js';
import { TilesModule } from './modules/tiles/index.js';
import { WeatherModule } from './modules/weather/index.js';
import { CommuteModule } from './modules/commute/index.js';
import { ReviewsModule } from './modules/reviews/index.js';
import { SharingModule } from './modules/sharing/index.js';
import { TripSharesModule } from './modules/trip-shares/index.js';
import { FollowersModule } from './modules/followers/index.js';
import { BadgesModule } from './modules/badges/index.js';
import { ChallengesModule } from './modules/challenges/index.js';
import { ExplorationModule } from './modules/exploration/index.js';
import { PassesModule } from './modules/passes/index.js';
import { PoiModule } from './modules/poi/index.js';
import { GeocodeModule } from './modules/geocode/index.js';
import { ClosuresModule } from './modules/closures/index.js';
import { AccountModule } from './modules/account/index.js';
import { TripsModule } from './modules/trips/index.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 60 }],
    }),
    DatabaseModule,
    AuthModule,
    AccountModule,
    UsersModule,
    HazardsModule,
    SensorModule,
    RoadsModule,
    SharingModule,
    TripSharesModule,
    RidesModule,
    TripsModule,
    EventsModule,
    SafetyModule,
    TilesModule,
    WeatherModule,
    CommuteModule,
    ReviewsModule,
    FollowersModule,
    BadgesModule,
    ChallengesModule,
    ExplorationModule,
    PassesModule,
    PoiModule,
    GeocodeModule,
    ClosuresModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
