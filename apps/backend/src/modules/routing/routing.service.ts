import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
} from '../commute/routing-provider.interface.js';
import { RouteEnrichmentService } from './route-enrichment.service.js';
import type { RouteRequestDto, RouteResponseDto } from './dto/route.dto.js';

@Injectable()
export class RoutingService {
  constructor(
    @Inject(ROUTING_PROVIDER) private readonly provider: RoutingProvider,
    private readonly enrichment: RouteEnrichmentService,
  ) {}

  async route(dto: RouteRequestDto): Promise<RouteResponseDto> {
    const route = await this.provider.route(
      dto.waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
      {
        avoidHighways: dto.options?.avoid_highways,
        avoidTolls: dto.options?.avoid_tolls,
        preferQuality: dto.options?.prefer_quality,
      },
    );
    if (!route) {
      throw new BadGatewayException('No road route between these points');
    }
    const m = await this.enrichment.aggregate(route.geometry);
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
