import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSetting } from '../../entities/app-setting.entity.js';
import { AppSettingsService } from './app-settings.service.js';

/**
 * Operator app settings. Exported service is consumed by the auth module
 * (launch-tier grant at registration) and the admin system-settings
 * controller (registered in `AdminModule`, tarmoto's pattern for admin
 * surfaces).
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting])],
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class AppSettingsModule {}
