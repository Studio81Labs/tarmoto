import { Module } from '@nestjs/common';
import { CommuteModule } from '../commute/index.js';
import { RoutingController } from './routing.controller.js';
import { RoutingService } from './routing.service.js';
import { RouteEnrichmentService } from './route-enrichment.service.js';

@Module({
  imports: [CommuteModule],
  controllers: [RoutingController],
  providers: [RoutingService, RouteEnrichmentService],
  exports: [RouteEnrichmentService],
})
export class RoutingModule {}
