import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
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
import { UserLimit } from '../../entities/user-limit.entity.js';
import { LimitState } from '../../entities/limit-state.entity.js';
import { EmailLog } from '../../entities/email-log.entity.js';
import { EmailTemplate } from '../../entities/email-template.entity.js';
import { HazardsModule } from '../hazards/hazards.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { EventsModule } from '../events/events.module.js';
import { AppSettingsModule } from '../app-settings/app-settings.module.js';
import { AdminAppSettingsController } from '../app-settings/admin-app-settings.controller.js';
import { PushModule } from '../push/index.js';
import { EmailModule } from '../email/index.js';
import { PoiModule } from '../poi/index.js';
import { AccountModule } from '../account/account.module.js';
import { QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { InternalGuard } from './internal.guard.js';
import {
  AdminAuditInterceptor,
  AdminAuditService,
} from './admin-audit.interceptor.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import { AdminMetricsService } from './admin-metrics.service.js';
import { AdminPoiController } from './admin-poi.controller.js';
import { PoiUploadLockInterceptor } from './poi-upload-lock.interceptor.js';
import { AdminUsersController } from '../admin-users/admin-users.controller.js';
import { AdminUsersService } from '../admin-users/admin-users.service.js';
import { AdminAdminsController } from '../admin-admins/admin-admins.controller.js';
import { AdminAdminsService } from '../admin-admins/admin-admins.service.js';
import { AdminFlagsController } from '../admin-flags/admin-flags.controller.js';
import { AdminFlagsService } from '../admin-flags/admin-flags.service.js';
import { AdminLimitsController } from '../admin-flags/admin-limits.controller.js';
import { AdminLimitsService } from '../admin-flags/admin-limits.service.js';
import { AdminSystemSwitchesController } from '../admin-flags/admin-system-switches.controller.js';
import { AdminSystemSwitchesService } from '../admin-flags/admin-system-switches.service.js';
import { AdminContentController } from '../admin-content/admin-content.controller.js';
import { AdminContentService } from '../admin-content/admin-content.service.js';
import { AdminEmailController } from '../admin-email/admin-email.controller.js';
import { AdminEmailService } from '../admin-email/admin-email.service.js';
import { AdminEmailTemplateController } from '../admin-email/admin-email-template.controller.js';
import { AdminEmailTemplateService } from '../admin-email/admin-email-template.service.js';

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
      UserLimit,
      LimitState,
      EmailLog,
      EmailTemplate,
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
    // admin-email test-send reuses EmailService.
    EmailModule,
    // Exposes PoiImportAdminService so admin-poi can read region/run status
    // and drive uploads/manual triggers. No forwardRef needed: PoiModule
    // (and everything it imports — PoiDatabaseModule, the upload-lock Redis
    // client) has no dependency back on AdminModule.
    PoiModule,
    // Exposes AccountDeletionService so admin-users' restore endpoint delegates
    // to the grace-window reversal (re-enable Stripe renewal + resolve the open
    // deletion_cancel_failed reconciliation under the per-rider advisory lock)
    // instead of clearing the deletion columns directly. AccountModule has no
    // dependency back on AdminModule, so no forwardRef is needed.
    AccountModule,
    // Register the digest queue TOKEN so admin-email can enqueue a resend. The
    // connection + workers come from JobsModule.forRoot() (imported once in
    // AppModule); importing JobsModule here can't provide JobsProducer because
    // that lives on the forRoot() dynamic module, and re-importing forRoot would
    // double-register every queue/processor. This mirrors data-export.module.
    BullModule.registerQueue({ name: QUEUE_NAMES.DIGEST_WEEKLY }),
  ],
  controllers: [
    AdminMetricsController,
    AdminUsersController,
    AdminAdminsController,
    AdminFlagsController,
    AdminLimitsController,
    AdminSystemSwitchesController,
    AdminContentController,
    AdminAppSettingsController,
    AdminEmailController,
    AdminEmailTemplateController,
    AdminPoiController,
  ],
  providers: [
    AdminAuditService,
    AdminMetricsService,
    AdminUsersService,
    AdminAdminsService,
    AdminFlagsService,
    AdminLimitsService,
    AdminSystemSwitchesService,
    AdminContentService,
    AdminEmailService,
    AdminEmailTemplateService,
    // Method-scoped interceptor on AdminPoiController's extract-upload endpoint;
    // must be a provider so Nest can resolve its PoiImportAdminService dep (#972).
    PoiUploadLockInterceptor,
    InternalGuard,
    { provide: APP_GUARD, useClass: InternalGuard },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuditService],
})
export class AdminModule {}
