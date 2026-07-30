import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { AccountModule } from '../account/account.module.js';
import { EventsModule } from '../events/index.js';
import { PushModule } from '../push/index.js';
import { FeaturesModule } from '../features/features.module.js';
import { HazardsController } from './hazards.controller.js';
import { HazardsService } from './hazards.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([HazardReport, CommuteRoute]),
    EventsModule,
    PushModule,
    AccountModule,
    // Exports FeatureResolver so `create()` can enforce the
    // `hazard_reports_per_day` anti-abuse cap.
    FeaturesModule,
  ],
  controllers: [HazardsController],
  providers: [HazardsService],
  exports: [HazardsService],
})
export class HazardsModule {}
