import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { haversineKm } from '@tarmoto/shared';
import {
  POI_PROVIDER,
  type PoiProvider,
  type AccommodationPoi,
  type PointOfInterest,
} from './poi-provider.interface.js';
import {
  ACCOMMODATION_KINDS,
  AccommodationDto,
  AccommodationListDto,
  type AccommodationKind,
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
} from './dto/accommodation.dto.js';
import {
  AlongRoutePoiDto,
  AlongRoutePoiListDto,
  AlongRoutePoiQueryDto,
  PoiDto,
  PoiListDto,
  POI_KINDS,
  type PoiKind,
  DEFAULT_BUFFER_KM,
  DEFAULT_RADIUS_KM as POI_DEFAULT_RADIUS_KM,
  MAX_BUFFER_KM,
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

/**
 * Per-kind cap for the route-wide POI response. A long multi-hour day
 * can legitimately pass 20+ fuel stations; the value is wider than the
 * point-anchored cap above because the mobile fuel-range warning only
 * surfaces stations inside an exceeding leg rather than every station
 * on the day. Restaurants/cafés use the same cap — noisy categories can
 * be narrowed by the client later via `kinds`.
 */
const MAX_ALONG_ROUTE_RESULTS_PER_KIND = 25;

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
    kinds?: AccommodationKind[],
    minStars?: number,
  ): Promise<AccommodationListDto> {
    const radius = this.clampRadiusKm(radiusKm);
    const resolvedKinds = this.resolveAccommodationKinds(kinds);
    let raw: AccommodationPoi[];
    try {
      raw = await this.provider.findAccommodations(
        lat,
        lng,
        radius,
        resolvedKinds,
      );
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
      return {
        accommodations: [],
        radius_km: radius,
        kinds: resolvedKinds,
      };
    }

    return {
      accommodations: this.rank(raw, lat, lng, resolvedKinds, minStars),
      radius_km: radius,
      kinds: resolvedKinds,
    };
  }

  /**
   * Sort suggestions by "usefulness" = named-first, then by distance. We
   * drop unnamed POIs with no website or phone — they'd show up on the
   * card as "Unnamed hotel" with no way to act on them, which is worse
   * than showing fewer results.
   *
   * `kinds` and `minStars` are applied here (not in the provider) so all
   * providers share the same filter semantics and the service is the
   * single source of truth for "no star rating → drop when min_stars is
   * set". Omit either to disable the corresponding filter.
   */
  rank(
    raw: AccommodationPoi[],
    lat: number,
    lng: number,
    kinds?: AccommodationKind[],
    minStars?: number,
  ): AccommodationDto[] {
    const kindSet =
      kinds && kinds.length > 0 ? new Set<AccommodationKind>(kinds) : undefined;
    const withDistance = raw
      .filter((poi) => (kindSet ? kindSet.has(poi.kind) : true))
      .filter((poi) =>
        minStars === undefined
          ? true
          : poi.stars !== null && poi.stars >= minStars,
      )
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

  /**
   * Find POIs within a buffer of a route polyline — primary driver of
   * the mobile fuel-range warning (US-36) and the trip-day POI card.
   *
   * Algorithm:
   *   1. Walk the polyline, sampling anchors so consecutive `around:`
   *      circles at the Overpass provider overlap (stride = `bufferKm`,
   *      plus the endpoints).
   *   2. Query the provider once with all samples as centres.
   *   3. For each returned POI, compute (a) the distance to its nearest
   *      route vertex and (b) the cumulative distance-along-route at
   *      that vertex. Drop POIs farther than the buffer — the provider's
   *      union of circles can return points that are inside the nearest
   *      circle but outside the polygon-ish corridor we actually care
   *      about (e.g. a petrol station 2 km off a switchback).
   *   4. Dedupe by `external_id`, keeping the closest instance.
   *   5. Cap per-kind and sort by `distance_along_route_km` so the mobile
   *      timeline renders naturally from start to end.
   */
  async findPointsOfInterestAlongRoute(
    dto: AlongRoutePoiQueryDto,
  ): Promise<AlongRoutePoiListDto> {
    if (dto.route.length < 2) {
      throw new BadRequestException('Route must have at least 2 points');
    }
    const bufferKm = this.clampBufferKm(dto.buffer_km);
    const resolvedKinds = this.resolveKinds(dto.kinds);

    const cumKm = cumulativeLengthKm(dto.route);
    const totalKm = cumKm[cumKm.length - 1];
    const samples = sampleRouteAnchors(dto.route, cumKm, bufferKm);

    let raw: PointOfInterest[];
    try {
      raw = await this.provider.findPointsOfInterestAroundPoints(
        samples,
        bufferKm,
        resolvedKinds,
      );
    } catch (err) {
      // Same resilience pattern as the point endpoints: a provider
      // outage collapses to an empty payload rather than breaking the
      // trip planner's rendering.
      this.logger.warn(
        `POI provider failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        pois: [],
        buffer_km: bufferKm,
        kinds: resolvedKinds,
        route_length_km: roundKmTenth(totalKm),
      };
    }

    return {
      pois: this.rankAlongRoute(raw, dto.route, cumKm, bufferKm, resolvedKinds),
      buffer_km: bufferKm,
      kinds: resolvedKinds,
      route_length_km: roundKmTenth(totalKm),
    };
  }

  /**
   * Drop off-buffer POIs, dedupe by external id, cap per-kind, and sort
   * by distance-along-route. Also filters to the caller's kinds —
   * defence-in-depth in case a misbehaving provider ignores the `kinds`
   * filter, same rule the point-anchored rankers apply.
   */
  rankAlongRoute(
    raw: PointOfInterest[],
    route: ReadonlyArray<{ lat: number; lng: number }>,
    cumKm: number[],
    bufferKm: number,
    kinds: PoiKind[],
  ): AlongRoutePoiDto[] {
    const kindSet = new Set<PoiKind>(kinds);
    type Annotated = {
      poi: PointOfInterest;
      distance_along_route_km: number;
      distance_from_route_km: number;
    };

    const deduped = new Map<string, Annotated>();
    for (const poi of raw) {
      if (!kindSet.has(poi.kind)) continue;
      if (!poi.name?.trim() && !poi.website && !poi.phone) continue;
      // Find nearest route vertex by haversine. Exact point-to-polyline
      // (perpendicular drop) would be more accurate, but for buffers of
      // a few kilometres the vertex distance sits within noise of the
      // upstream tag precision. Keeping this as a vertex sweep also
      // means we can read the "distance along" straight out of `cumKm`.
      let bestIdx = 0;
      let bestKm = Infinity;
      for (let i = 0; i < route.length; i++) {
        const d = haversineKm(poi.lat, poi.lng, route[i].lat, route[i].lng);
        if (d < bestKm) {
          bestKm = d;
          bestIdx = i;
        }
      }
      if (bestKm > bufferKm) continue;

      const entry: Annotated = {
        poi,
        distance_along_route_km: cumKm[bestIdx],
        distance_from_route_km: bestKm,
      };
      const prev = deduped.get(poi.external_id);
      if (!prev || entry.distance_from_route_km < prev.distance_from_route_km) {
        deduped.set(poi.external_id, entry);
      }
    }

    const byKind = new Map<PoiKind, Annotated[]>();
    for (const entry of deduped.values()) {
      const list = byKind.get(entry.poi.kind) ?? [];
      list.push(entry);
      byKind.set(entry.poi.kind, list);
    }

    const kept: Annotated[] = [];
    for (const list of byKind.values()) {
      // Within each kind, prefer rows closer to the route — unlike the
      // point ranker we don't down-rank unnamed rows here because an
      // unnamed fuel station right on the route is still useful for the
      // fuel-range warning; the null-contact filter above already drops
      // the truly opaque ones.
      list.sort((a, b) => a.distance_from_route_km - b.distance_from_route_km);
      for (const entry of list.slice(0, MAX_ALONG_ROUTE_RESULTS_PER_KIND)) {
        kept.push(entry);
      }
    }

    kept.sort((a, b) => a.distance_along_route_km - b.distance_along_route_km);

    return kept.map(
      ({ poi, distance_along_route_km, distance_from_route_km }) => ({
        external_id: poi.external_id,
        name: poi.name,
        kind: poi.kind,
        lat: poi.lat,
        lng: poi.lng,
        distance_along_route_km: roundKmTenth(distance_along_route_km),
        distance_from_route_km: roundKmTenth(distance_from_route_km),
        website: poi.website,
        phone: poi.phone,
        hint: poi.hint,
      }),
    );
  }

  private clampRadiusKm(input: number | undefined): number {
    return clampRadius(input, DEFAULT_RADIUS_KM, MAX_RADIUS_KM);
  }

  private clampBufferKm(input: number | undefined): number {
    // Lower bound of 0.5 km matches the DTO's `@Min(0.5)` — anything
    // smaller is below the precision of the OSM coordinates we consume
    // and would just filter out matches the provider already returned.
    if (input === undefined || !Number.isFinite(input)) {
      return DEFAULT_BUFFER_KM;
    }
    if (input < 0.5) return DEFAULT_BUFFER_KM;
    return Math.min(input, MAX_BUFFER_KM);
  }

  private clampPoiRadiusKm(input: number | undefined): number {
    return clampRadius(input, POI_DEFAULT_RADIUS_KM, POI_MAX_RADIUS_KM);
  }

  private resolveKinds(input: PoiKind[] | undefined): PoiKind[] {
    if (!input || input.length === 0) return [...POI_KINDS];
    return Array.from(new Set(input));
  }

  private resolveAccommodationKinds(
    input: AccommodationKind[] | undefined,
  ): AccommodationKind[] {
    if (!input || input.length === 0) return [...ACCOMMODATION_KINDS];
    return Array.from(new Set(input));
  }
}

/**
 * Resolve a radius (km) query parameter. Returns `defaultKm` when the
 * input is missing, non-finite, or non-positive; otherwise caps at
 * `maxKm`. Accommodation and POI lookups share this logic but keep
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

/**
 * Build the per-vertex cumulative-distance table for a polyline. The
 * service uses this twice: once to sample `around:` anchors at regular
 * intervals, and once to look up a POI's distance-along-route from the
 * index of its nearest vertex.
 */
export function cumulativeLengthKm(
  route: ReadonlyArray<{ lat: number; lng: number }>,
): number[] {
  const cum = new Array<number>(route.length);
  cum[0] = 0;
  for (let i = 1; i < route.length; i++) {
    cum[i] =
      cum[i - 1] +
      haversineKm(
        route[i - 1].lat,
        route[i - 1].lng,
        route[i].lat,
        route[i].lng,
      );
  }
  return cum;
}

/**
 * Pick a minimal set of anchor points along the polyline such that a
 * `bufferKm`-radius circle at each anchor covers the entire route.
 *
 * Stride is `bufferKm`: adjacent circles then overlap by half a radius
 * on either side, which means a rider running along the polyline never
 * leaves the covered corridor even near sharp bends (where a naive
 * `2 * bufferKm` stride can drop coverage on the inside of the turn).
 * The route start and end are always included so the corridor doesn't
 * trail off before the last vertex.
 *
 * Exported for tests — this is the function under test when validating
 * that the samples reach the whole corridor.
 */
export function sampleRouteAnchors(
  route: ReadonlyArray<{ lat: number; lng: number }>,
  cumKm: number[],
  bufferKm: number,
): { lat: number; lng: number }[] {
  if (route.length === 0) return [];
  if (route.length === 1) return [{ lat: route[0].lat, lng: route[0].lng }];

  const totalKm = cumKm[cumKm.length - 1];
  const stride = Math.max(bufferKm, 0.5);
  // +1 for the endpoint. For a 200 km day at 2 km buffer this is ~101
  // samples — comfortably under Overpass's soft 256-element `around:`
  // limit. The service layer clamps buffer ≥ 0.5 km (matches the DTO)
  // so the worst case stays bounded.
  const targetCount = Math.floor(totalKm / stride) + 1;

  const anchors: { lat: number; lng: number }[] = [
    { lat: route[0].lat, lng: route[0].lng },
  ];
  let nextBoundary = stride;
  for (let i = 1; i < route.length && anchors.length <= targetCount; i++) {
    if (cumKm[i] >= nextBoundary) {
      anchors.push({ lat: route[i].lat, lng: route[i].lng });
      // Advance past the vertex we just consumed rather than by a fixed
      // stride so a cluster of close vertices (common on curvy mountain
      // roads) doesn't duplicate the anchor.
      nextBoundary = cumKm[i] + stride;
    }
  }
  // Always include the final vertex so the tail of the route is covered
  // even when the stride hasn't landed exactly on it.
  const last = route[route.length - 1];
  const lastAnchor = anchors[anchors.length - 1];
  if (lastAnchor.lat !== last.lat || lastAnchor.lng !== last.lng) {
    anchors.push({ lat: last.lat, lng: last.lng });
  }
  return anchors;
}

function roundKmTenth(km: number): number {
  return Math.round(km * 10) / 10;
}
