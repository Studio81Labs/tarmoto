import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserScopedThrottlerGuard } from './config/user-scoped-throttler.guard.js';
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
import { MapSharesModule } from './modules/map-shares/index.js';
import { RouteCollectionsModule } from './modules/route-collections/index.js';
import { FollowersModule } from './modules/followers/index.js';
import { BadgesModule } from './modules/badges/index.js';
import { ChallengesModule } from './modules/challenges/index.js';
import { LeaderboardsModule } from './modules/leaderboards/index.js';
import { ExplorationModule } from './modules/exploration/index.js';
import { PassesModule } from './modules/passes/index.js';
import { PoiModule } from './modules/poi/index.js';
import { GeocodeModule } from './modules/geocode/index.js';
import { ClosuresModule } from './modules/closures/index.js';
import { AccountModule } from './modules/account/index.js';
import { BikesModule } from './modules/bikes/bikes.module.js';
import { EmailModule } from './modules/email/index.js';
import { TripsModule } from './modules/trips/index.js';
import { TripFoldersModule } from './modules/trip-folders/index.js';
import { TripActivityModule } from './modules/trip-activity/index.js';
import { GroupRidesModule } from './modules/group-rides/index.js';
import { JobsModule } from './modules/jobs/index.js';
import { PushModule } from './modules/push/index.js';
import { StorageModule } from './modules/storage/index.js';
import { ModelEvalModule } from './modules/model-eval/index.js';
import { RoutingModule } from './modules/routing/routing.module.js';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { ClientConfigModule } from './modules/client-config/client-config.module.js';
import { NapModule } from './modules/nap/nap.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 60 }],
    }),
    DatabaseModule,
    EmailModule,
    StorageModule,
    AuthModule,
    AccountModule,
    BikesModule,
    JobsModule.forRoot(),
    UsersModule,
    HazardsModule,
    ModelEvalModule,
    SensorModule,
    RoadsModule,
    SharingModule,
    TripSharesModule,
    MapSharesModule,
    RouteCollectionsModule,
    RidesModule,
    TripsModule,
    TripFoldersModule,
    TripActivityModule,
    GroupRidesModule,
    EventsModule,
    SafetyModule,
    TilesModule,
    WeatherModule,
    CommuteModule,
    ReviewsModule,
    FollowersModule,
    BadgesModule,
    ChallengesModule,
    LeaderboardsModule,
    ExplorationModule,
    PassesModule,
    PoiModule,
    GeocodeModule,
    ClosuresModule,
    NapModule,
    PushModule,
    RoutingModule,
    AdminAuthModule,
    AdminModule,
    ClientConfigModule,
  ],
  controllers: [AppController],
  // Global APP_GUARD throttles every route by `(ip, user_id)` instead
  // of plain IP. See `UserScopedThrottlerGuard` for why — short
  // version: riders behind a shared NAT must not be able to starve
  // each other's safety-endpoint budget.
  providers: [
    AppService,
    // Captures unhandled exceptions to Sentry. Harmless when Sentry is not
    // configured (no DSN → Sentry.init never ran → nothing is sent).
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    { provide: APP_GUARD, useClass: UserScopedThrottlerGuard },
  ],
})
export class AppModule {}
