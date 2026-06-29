import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardsModule } from '../hazards/hazards.module.js';
import { WeatherModule } from '../weather/weather.module.js';
import { ClosuresModule } from '../closures/index.js';
import { CommuteController } from './commute.controller.js';
import { CommuteService } from './commute.service.js';
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
} from './routing-provider.interface.js';
import { OsrmProvider } from './providers/osrm.provider.js';
import { ValhallaProvider } from './providers/valhalla.provider.js';

/**
 * Selects the routing engine for the shared ROUTING_PROVIDER token (used by
 * commute, the trip generator, and the planner /routing/route endpoint).
 *
 * Valhalla is self-hosted and opt-in — its docker service sits behind the
 * `routing` compose profile, so the documented `pnpm db:up` dev setup does NOT
 * start it. We therefore only use Valhalla when it has been explicitly
 * configured via TARMOTO_VALHALLA_BASE_URL, and otherwise fall back to OSRM
 * (public demo by default). This keeps commute + trip generation working out of
 * the box instead of returning no route against a Valhalla that isn't running.
 */
export function routingProviderFactory(
  config: ConfigService,
  osrm: OsrmProvider,
  valhalla: ValhallaProvider,
): RoutingProvider {
  return config.get<string>('TARMOTO_VALHALLA_BASE_URL') ? valhalla : osrm;
}

/**
 * To swap the routing engine (e.g., to GraphHopper or Mapbox), add a provider
 * and adjust `routingProviderFactory` above.
 *
 * `HazardsModule` and `WeatherModule` are imported so
 * `/commute/status` can return hazards + weather inline (#353). Both
 * modules expose their service publicly via `exports`, so we just
 * import them directly.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CommuteRoute, Ride]),
    HazardsModule,
    WeatherModule,
    ClosuresModule,
  ],
  controllers: [CommuteController],
  providers: [
    CommuteService,
    OsrmProvider,
    ValhallaProvider,
    {
      provide: ROUTING_PROVIDER,
      inject: [ConfigService, OsrmProvider, ValhallaProvider],
      useFactory: routingProviderFactory,
    },
  ],
  // ROUTING_PROVIDER is exported so other features (e.g. the trip
  // auto-generator in `TripsModule`) can reuse the same routing engine
  // configuration without re-registering the provider in their own
  // module — this keeps the routing swap-out story in one place.
  exports: [CommuteService, ROUTING_PROVIDER],
})
export class CommuteModule {}
