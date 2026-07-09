import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminUser } from '../../entities/admin-user.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminRefreshToken } from '../../entities/admin-refresh-token.entity.js';
import { AdminAuditLog } from '../../entities/admin-audit-log.entity.js';
import { User } from '../../entities/user.entity.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { UserFeature } from '../../entities/user-feature.entity.js';
import { FeatureState } from '../../entities/feature-state.entity.js';
import { EmailLog } from '../../entities/email-log.entity.js';
import { HazardsModule } from '../hazards/hazards.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { EventsModule } from '../events/events.module.js';
import { AppSettingsModule } from '../app-settings/app-settings.module.js';
import { AdminAppSettingsController } from '../app-settings/admin-app-settings.controller.js';
import { PushModule } from '../push/index.js';
import { InternalGuard } from './internal.guard.js';
import {
  AdminAuditInterceptor,
  AdminAuditService,
} from './admin-audit.interceptor.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import { AdminMetricsService } from './admin-metrics.service.js';
import { AdminUsersController } from '../admin-users/admin-users.controller.js';
import { AdminUsersService } from '../admin-users/admin-users.service.js';
import { AdminAdminsController } from '../admin-admins/admin-admins.controller.js';
import { AdminAdminsService } from '../admin-admins/admin-admins.service.js';
import { AdminFlagsController } from '../admin-flags/admin-flags.controller.js';
import { AdminFlagsService } from '../admin-flags/admin-flags.service.js';
import { AdminContentController } from '../admin-content/admin-content.controller.js';
import { AdminContentService } from '../admin-content/admin-content.service.js';
import { AdminEmailController } from '../admin-email/admin-email.controller.js';
import { AdminEmailService } from '../admin-email/admin-email.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdminUser,
      AdminSession,
      AdminRefreshToken,
      AdminAuditLog,
      User,
      RoadClosure,
      Ride,
      HazardReport,
      RoadReview,
      Trip,
      TripMessage,
      CommuteRoute,
      UserFeature,
      FeatureState,
      EmailLog,
    ]),
    HazardsModule,
    ReviewsModule,
    FeaturesModule,
    // The flags service kicks revoked users out of live group-ride
    // socket rooms via the gateway.
    EventsModule,
    AppSettingsModule,
    // Exposes NotificationPreferencesService so admin-users can read/update a
    // user's notification preferences from the user-detail screen.
    PushModule,
  ],
  controllers: [
    AdminMetricsController,
    AdminUsersController,
    AdminAdminsController,
    AdminFlagsController,
    AdminContentController,
    AdminAppSettingsController,
    AdminEmailController,
  ],
  providers: [
    AdminAuditService,
    AdminMetricsService,
    AdminUsersService,
    AdminAdminsService,
    AdminFlagsService,
    AdminContentService,
    AdminEmailService,
    InternalGuard,
    { provide: APP_GUARD, useClass: InternalGuard },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuditService],
})
export class AdminModule {}
