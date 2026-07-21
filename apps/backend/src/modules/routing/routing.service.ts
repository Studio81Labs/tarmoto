import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
} from '../commute/routing-provider.interface.js';
import { RouteEnrichmentService } from './route-enrichment.service.js';
import type { RouteRequestDto, RouteResponseDto } from './dto/route.dto.js';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    @Inject(ROUTING_PROVIDER) private readonly provider: RoutingProvider,
    private readonly enrichment: RouteEnrichmentService,
  ) {}

  async route(
    dto: RouteRequestDto,
    signal?: AbortSignal,
  ): Promise<RouteResponseDto> {
    const startedAt = Date.now();
    const providerStartedAt = Date.now();
    const waypoints = dto.waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
    const options = {
      avoidHighways: dto.options?.avoid_highways,
      avoidTolls: dto.options?.avoid_tolls,
      preferQuality: dto.options?.prefer_quality,
      preference: dto.options?.preference,
    };
    const route = signal
      ? await this.provider.route(waypoints, options, signal)
      : await this.provider.route(waypoints, options);
    const providerMs = Date.now() - providerStartedAt;
    if (!route) {
      throw new BadGatewayException('No road route between these points');
    }
    signal?.throwIfAborted();
    const enrichmentStartedAt = Date.now();
    const m = signal
      ? await this.enrichment.aggregate(route.geometry, signal)
      : await this.enrichment.aggregate(route.geometry);
    const enrichmentMs = Date.now() - enrichmentStartedAt;
    const totalMs = Date.now() - startedAt;
    if (totalMs >= 1_000) {
      this.logger.warn(
        `Planner route took ${totalMs}ms ` +
          `(provider=${providerMs}ms, enrichment=${enrichmentMs}ms, ` +
          `waypoints=${dto.waypoints.length})`,
      );
    }
    return {
      geometry: route.geometry,
      distance_km: route.distance_km,
      duration_min: route.duration_min,
      avg_quality: m.avgQuality,
      curviness_score: m.curvinessScore,
      elevation_gain_m: m.elevationGain,
      surface_mix: m.surfaceMixMetres,
    };
  }
}
