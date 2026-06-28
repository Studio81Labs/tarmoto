import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeatureFlag } from '../../entities/feature-flag.entity.js';
import { ClientConfigController } from './client-config.controller.js';
import { ClientConfigService } from './client-config.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([FeatureFlag])],
  controllers: [ClientConfigController],
  providers: [ClientConfigService],
})
export class ClientConfigModule {}
