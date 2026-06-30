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
import { GraphHopperProvider } from './providers/graphhopper.provider.js';

/**
 * Selects the routing engine for the shared ROUTING_PROVIDER token (used by
 * commute, the trip generator, and the planner /routing/route endpoint).
 *
 * All non-OSRM engines are self-hosted and opt-in (their docker services sit
 * behind the `routing` compose profile, so the documented `pnpm db:up` dev
 * setup does NOT start them). We pick by explicit configuration and otherwise
 * fall back to OSRM (public demo by default), so commute + trip generation
 * work out of the box instead of returning no route against an engine that
 * isn't running.
 *
 * Precedence: GraphHopper (ADR-0004 — request-time `custom_model` avoidances,
 * and the future home for our own road-quality weighting) → Valhalla → OSRM.
 * GraphHopper is selected by EITHER its base URL (self-hosted) OR its API key
 * (hosted Directions API, whose base URL the provider defaults), so the
 * key-only hosted setup isn't silently ignored.
 */
export function routingProviderFactory(
  config: ConfigService,
  osrm: OsrmProvider,
  valhalla: ValhallaProvider,
  graphhopper: GraphHopperProvider,
): RoutingProvider {
  // Trim before opting in: a whitespace-only templated env value must count
  // as unset, matching how each provider normalizes it. Otherwise the
  // factory would pick an engine the provider then can't reach (e.g.
  // GraphHopper falling back to a local port nothing is serving).
  const set = (key: string): boolean =>
    Boolean(config.get<string>(key)?.trim());
  if (
    set('TARMOTO_GRAPHHOPPER_BASE_URL') ||
    set('TARMOTO_GRAPHHOPPER_API_KEY')
  ) {
    return graphhopper;
  }
  if (set('TARMOTO_VALHALLA_BASE_URL')) return valhalla;
  return osrm;
}

/**
 * To swap the routing engine, add a provider implementing `RoutingProvider`
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
    GraphHopperProvider,
    {
      provide: ROUTING_PROVIDER,
      inject: [
        ConfigService,
        OsrmProvider,
        ValhallaProvider,
        GraphHopperProvider,
      ],
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
