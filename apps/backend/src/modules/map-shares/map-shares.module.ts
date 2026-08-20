import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MapShare } from '../../entities/map-share.entity.js';
import { FeaturesModule } from '../features/features.module.js';
import { MapSharesController } from './map-shares.controller.js';
import { MapSharesService } from './map-shares.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([MapShare]), FeaturesModule],
  controllers: [MapSharesController],
  providers: [MapSharesService],
  exports: [MapSharesService],
})
export class MapSharesModule {}
