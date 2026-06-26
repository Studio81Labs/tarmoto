import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminUser } from '../../entities/admin-user.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminAuditLog } from '../../entities/admin-audit-log.entity.js';
import { User } from '../../entities/user.entity.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { InternalGuard } from './internal.guard.js';
import {
  AdminAuditInterceptor,
  AdminAuditService,
} from './admin-audit.interceptor.js';
import { AdminMetricsController } from './admin-metrics.controller.js';
import { AdminMetricsService } from './admin-metrics.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdminUser,
      AdminSession,
      AdminAuditLog,
      User,
      RoadClosure,
    ]),
  ],
  controllers: [AdminMetricsController],
  providers: [
    AdminAuditService,
    AdminMetricsService,
    InternalGuard,
    { provide: APP_GUARD, useClass: InternalGuard },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuditService],
})
export class AdminModule {}
