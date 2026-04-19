import { Inject, Injectable, Logger } from '@nestjs/common';
import { haversineKm } from '@tarmoto/shared';
import {
  POI_PROVIDER,
  type PoiProvider,
  type AccommodationPoi,
  type PointOfInterest,
} from './poi-provider.interface.js';
import {
  AccommodationDto,
  AccommodationListDto,
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
} from './dto/accommodation.dto.js';
import {
  PoiDto,
  PoiListDto,
  POI_KINDS,
  type PoiKind,
  DEFAULT_RADIUS_KM as POI_DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM as POI_MAX_RADIUS_KM,
} from './dto/point-of-interest.dto.js';

/**
 * Number of accommodations the mobile card surfaces. Anything beyond this
 * is visual noise on a small screen; riders looking for a longer list can
 * open a maps app directly.
 */
const MAX_RESULTS = 8;

/**
 * Per-kind cap for the along-route POI response. The mobile card splits
 * results into one row per kind; keeping each kind bounded stops any
 * single popular kind (usually `restaurant`) from squeezing the others
 * out of the ranked top-N.
 */
const MAX_POI_RESULTS_PER_KIND = 6;

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

  async findPointsOfInterestNear(
    lat: number,
    lng: number,
    radiusKm?: number,
    kinds?: PoiKind[],
  ): Promise<PoiListDto> {
    const radius = this.clampPoiRadiusKm(radiusKm);
    const resolvedKinds = this.resolveKinds(kinds);

    let raw: PointOfInterest[];
    try {
      raw = await this.provider.findPointsOfInterest(
        lat,
        lng,
        radius,
        resolvedKinds,
      );
    } catch (err) {
      // Same resilience as accommodations: an Overpass outage shows an
      // empty state instead of breaking the day view. Coordinates are
      // omitted from the log on purpose — see findAccommodationsNear.
      this.logger.warn(
        `POI provider failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { pois: [], radius_km: radius, kinds: resolvedKinds };
    }

    return {
      pois: this.rankPois(raw, lat, lng, resolvedKinds),
      radius_km: radius,
      kinds: resolvedKinds,
    };
  }

  /**
   * Rank POIs per-kind so one dense category (usually restaurants) can't
   * crowd viewpoints and cafés out of the response. Each kind keeps its
   * own slot budget and is independently sorted by name-presence first,
   * then distance — the same "has something actionable at the top" rule
   * the accommodation ranker uses. Final output is still overall
   * distance-sorted so the closest-first ordering the mobile card
   * renders is preserved.
   */
  rankPois(
    raw: PointOfInterest[],
    lat: number,
    lng: number,
    kinds: PoiKind[],
  ): PoiDto[] {
    const kindSet = new Set<PoiKind>(kinds);
    const withDistance = raw
      .filter((poi) => kindSet.has(poi.kind))
      .map((poi) => ({
        poi,
        distance_km: haversineKm(lat, lng, poi.lat, poi.lng),
      }))
      // Drop rows with no name AND no contact — same rationale as the
      // accommodation ranker: an "Unnamed cafe" row with no phone or
      // website is worse than showing fewer results.
      .filter(({ poi }) => !!poi.name?.trim() || !!poi.website || !!poi.phone);

    const byKind = new Map<PoiKind, typeof withDistance>();
    for (const entry of withDistance) {
      const list = byKind.get(entry.poi.kind) ?? [];
      list.push(entry);
      byKind.set(entry.poi.kind, list);
    }

    const kept: typeof withDistance = [];
    for (const list of byKind.values()) {
      list.sort((a, b) => {
        const aHasName = !!a.poi.name?.trim();
        const bHasName = !!b.poi.name?.trim();
        if (aHasName !== bHasName) return aHasName ? -1 : 1;
        return a.distance_km - b.distance_km;
      });
      for (const entry of list.slice(0, MAX_POI_RESULTS_PER_KIND)) {
        kept.push(entry);
      }
    }

    kept.sort((a, b) => a.distance_km - b.distance_km);

    return kept.map(({ poi, distance_km }) => ({
      external_id: poi.external_id,
      name: poi.name,
      kind: poi.kind,
      lat: poi.lat,
      lng: poi.lng,
      distance_km: Math.round(distance_km * 10) / 10,
      website: poi.website,
      phone: poi.phone,
      hint: poi.hint,
    }));
  }

  private clampRadiusKm(input: number | undefined): number {
    return clampRadius(input, DEFAULT_RADIUS_KM, MAX_RADIUS_KM);
  }

  private clampPoiRadiusKm(input: number | undefined): number {
    return clampRadius(input, POI_DEFAULT_RADIUS_KM, POI_MAX_RADIUS_KM);
  }

  private resolveKinds(input: PoiKind[] | undefined): PoiKind[] {
    if (!input || input.length === 0) return [...POI_KINDS];
    return Array.from(new Set(input));
  }
}

/**
 * Clamp a radius (km) query parameter into the `[defaultKm, maxKm]`
 * window. Accommodation and POI lookups share this logic but keep
 * their own constants since the two endpoints are semantically
 * independent — they could diverge in the future (e.g. a wider cap for
 * along-route POIs) without touching the accommodation contract.
 */
function clampRadius(
  input: number | undefined,
  defaultKm: number,
  maxKm: number,
): number {
  if (input === undefined || !Number.isFinite(input)) return defaultKm;
  if (input <= 0) return defaultKm;
  return Math.min(input, maxKm);
}
