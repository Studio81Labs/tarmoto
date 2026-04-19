import { Inject, Injectable, Logger } from '@nestjs/common';
import { haversineKm } from '@tarmoto/shared';
import {
  POI_PROVIDER,
  type PoiProvider,
  type AccommodationPoi,
} from './poi-provider.interface.js';
import {
  AccommodationDto,
  AccommodationListDto,
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
} from './dto/accommodation.dto.js';

/**
 * Number of accommodations the mobile card surfaces. Anything beyond this
 * is visual noise on a small screen; riders looking for a longer list can
 * open a maps app directly.
 */
const MAX_RESULTS = 8;

@Injectable()
export class PoiService {
  private readonly logger = new Logger(PoiService.name);

  constructor(
    @Inject(POI_PROVIDER)
    private readonly provider: PoiProvider,
  ) {}

  async findAccommodationsNear(
    lat: number,
    lng: number,
    radiusKm?: number,
  ): Promise<AccommodationListDto> {
    const radius = this.clampRadiusKm(radiusKm);
    let raw: AccommodationPoi[];
    try {
      raw = await this.provider.findAccommodations(lat, lng, radius);
    } catch (err) {
      // Keep trip planning resilient: if the upstream provider is down or
      // rate-limited, the day card just shows an empty state instead of
      // blocking the whole screen.
      // Log only the error cause. Rider coordinates are intentionally
      // omitted so an Overpass outage can't bulk-leak precise trip
      // locations into backend logs.
      this.logger.warn(
        `POI provider failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { accommodations: [], radius_km: radius };
    }

    return {
      accommodations: this.rank(raw, lat, lng),
      radius_km: radius,
    };
  }

  /**
   * Sort suggestions by "usefulness" = named-first, then by distance. We
   * drop unnamed POIs with no website or phone — they'd show up on the
   * card as "Unnamed hotel" with no way to act on them, which is worse
   * than showing fewer results.
   */
  rank(raw: AccommodationPoi[], lat: number, lng: number): AccommodationDto[] {
    const withDistance = raw
      .map((poi) => ({
        poi,
        distance_km: haversineKm(lat, lng, poi.lat, poi.lng),
      }))
      .filter(({ poi }) => !!poi.name?.trim() || !!poi.website || !!poi.phone);

    withDistance.sort((a, b) => {
      const aHasName = !!a.poi.name?.trim();
      const bHasName = !!b.poi.name?.trim();
      if (aHasName !== bHasName) return aHasName ? -1 : 1;
      return a.distance_km - b.distance_km;
    });

    return withDistance.slice(0, MAX_RESULTS).map(({ poi, distance_km }) => ({
      external_id: poi.external_id,
      name: poi.name,
      kind: poi.kind,
      lat: poi.lat,
      lng: poi.lng,
      distance_km: Math.round(distance_km * 10) / 10,
      website: poi.website,
      phone: poi.phone,
      stars: poi.stars,
    }));
  }

  private clampRadiusKm(input: number | undefined): number {
    if (input === undefined || !Number.isFinite(input)) {
      return DEFAULT_RADIUS_KM;
    }
    if (input <= 0) return DEFAULT_RADIUS_KM;
    return Math.min(input, MAX_RADIUS_KM);
  }
}
