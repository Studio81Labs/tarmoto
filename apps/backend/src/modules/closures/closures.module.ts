import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { FeaturesModule } from '../features/features.module.js';
import { ClosuresController } from './closures.controller.js';
import { ClosuresService } from './closures.service.js';

/**
 * Imports FeaturesModule so ClosuresService can gate closure display
 * (`list`/`checkRoute`/`getById`) behind `sys_nap_conditions` and routing
 * avoidance (`exclusionPolygons`) behind `sys_nap_routing_avoidance` — two
 * independent operator kill switches.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RoadClosure]), FeaturesModule],
  controllers: [ClosuresController],
  providers: [ClosuresService],
  exports: [ClosuresService],
})
export class ClosuresModule {}
