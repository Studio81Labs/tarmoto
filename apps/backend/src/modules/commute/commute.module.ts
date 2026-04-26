import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { CommuteController } from './commute.controller.js';
import { CommuteService } from './commute.service.js';
import { ROUTING_PROVIDER } from './routing-provider.interface.js';
import { OsrmProvider } from './providers/osrm.provider.js';

/**
 * To swap the routing engine (e.g., to GraphHopper or Mapbox), change
 * the ROUTING_PROVIDER useClass below.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CommuteRoute, Ride])],
  controllers: [CommuteController],
  providers: [
    CommuteService,
    { provide: ROUTING_PROVIDER, useClass: OsrmProvider },
  ],
  // ROUTING_PROVIDER is exported so other features (e.g. the trip
  // auto-generator in `TripsModule`) can reuse the same routing engine
  // configuration without re-registering the provider in their own
  // module — this keeps the OSRM swap-out story in one place.
  exports: [CommuteService, ROUTING_PROVIDER],
})
export class CommuteModule {}
