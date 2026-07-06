import { Module } from '@nestjs/common';
import { FeaturesModule } from '../features/features.module.js';
import { ClientConfigController } from './client-config.controller.js';
import { ClientConfigService } from './client-config.service.js';

@Module({
  imports: [FeaturesModule],
  controllers: [ClientConfigController],
  providers: [ClientConfigService],
})
export class ClientConfigModule {}
