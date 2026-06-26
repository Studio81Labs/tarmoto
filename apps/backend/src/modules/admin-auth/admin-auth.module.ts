import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminUser } from '../../entities/admin-user.entity.js';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminRefreshToken } from '../../entities/admin-refresh-token.entity.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminModule } from '../admin/admin.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([AdminUser, AdminSession, AdminRefreshToken]),
    // AdminModule exports AdminAuditService, used by AdminAuthController to
    // record an audit row on successful SSO logins (GET callback bypasses the
    // AdminAuditInterceptor which only fires on mutating methods).
    // AdminModule does NOT import AdminAuthModule, so there is no cycle.
    AdminModule,
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
