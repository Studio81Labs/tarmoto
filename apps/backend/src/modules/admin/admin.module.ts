import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminUser } from '../../entities/admin-user.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminAuditLog } from '../../entities/admin-audit-log.entity.js';
import { User } from '../../entities/user.entity.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { InternalGuard } from './internal.guard.js';
import {
  AdminAuditInterceptor,
  AdminAuditService,
} from './admin-audit.interceptor.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import { AdminMetricsService } from './admin-metrics.service.js';
import { AdminUsersController } from '../admin-users/admin-users.controller.js';
import { AdminUsersService } from '../admin-users/admin-users.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdminUser,
      AdminSession,
      AdminAuditLog,
      User,
      RoadClosure,
      Ride,
      HazardReport,
      RoadReview,
      Trip,
      CommuteRoute,
    ]),
  ],
  controllers: [AdminMetricsController, AdminUsersController],
  providers: [
    AdminAuditService,
    AdminMetricsService,
    AdminUsersService,
    InternalGuard,
    { provide: APP_GUARD, useClass: InternalGuard },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuditService],
})
export class AdminModule {}
