import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { HazardsController } from './hazards.controller.js';
import { HazardsService } from './hazards.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([HazardReport])],
  controllers: [HazardsController],
  providers: [HazardsService],
  exports: [HazardsService],
})
export class HazardsModule {}
