import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  haversineKm,
  POI_KINDS,
  ACCOMMODATION_KINDS,
  type PoiKind,
  type AccommodationKind,
} from '@tarmoto/shared';
import {
  POI_PROVIDER,
  type PoiProvider,
  type AccommodationPoi,
  type PointOfInterest,
} from './poi-provider.interface.js';
import { googleMapsUrl, osmDetailUrl } from './poi-links.js';
import {
  AccommodationDto,
  AccommodationListDto,
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
} from './dto/accommodation.dto.js';
import {
  AlongRoutePoiDto,
  AlongRoutePoiListDto,
  AlongRoutePoiQueryDto,
  PoiDto,
  PoiListDto,
  DEFAULT_BUFFER_KM,
  DEFAULT_RADIUS_KM as POI_DEFAULT_RADIUS_KM,
  MAX_BUFFER_KM,
  MAX_RADIUS_KM as POI_MAX_RADIUS_KM,
} from './dto/point-of-interest.dto.js';
import { PoiStoreService } from './poi-store.service.js';
import {
  cumulativeLengthKm,
  projectOntoRoute,
  pointRadiusBbox,
  routeBufferBbox,
  bboxContains,
  type Bbox,
} from './poi-geo.js';
import { dedupeAcrossSources, sourceOfExternalId } from './poi-dedup.js';

// `cumulativeLengthKm` / `projectOntoRoute` live in `poi-geo.ts` so the store
// service can share them without a PoiService ↔ PoiStoreService import cycle.
// Re-exported so existing importers (the service spec) resolve them from here.
export { cumulativeLengthKm, projectOntoRoute } from './poi-geo.js';

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

/**
 * Merge store + Overpass POIs at a coverage frontier (#925), keeping every store
 * row and adding only the Overpass rows the store didn't already have (same
 * `external_id` = same OSM element; both paths build `osm:<type>:<id>`). Store
 * rows win so the richer imported decision-support fields survive; the ranker
 * downstream re-sorts and caps the union.
 */
function mergeByExternalId<T extends { external_id: string }>(
  store: T[],
  live: T[],
): T[] {
  const seen = new Set(store.map((poi) => poi.external_id));
  return [...store, ...live.filter((poi) => !seen.has(poi.external_id))];
}

@Injectable()
export class PoiService {
  private readonly logger = new Logger(PoiService.name);

  constructor(
    @Inject(POI_PROVIDER)
    private readonly provider: PoiProvider,
    private readonly store: PoiStoreService,
  ) {}

  /**
   * Store-first read with a live-provider fallback (#849). Try the offline
   * `pois` store; if it has no rows for the area (un-imported region) OR the
   * store is unavailable (a 503 outage — DB down / not yet connected), fall back
   * to the live provider so coverage never regresses outside the import bbox. A
   * provider outage (or both failing) collapses to an empty list — the endpoints
   * never 500 on an outage, and rider coordinates stay out of the logs (only the
   * error message is logged).
   *
   * Coverage-aware (#925): when `requestArea` is given and isn't fully inside
   * imported coverage (a request straddling the import frontier), the store's
   * rows are merged with a live Overpass query rather than treated as complete —
   * so the uncovered side isn't silently dropped. A fully-covered area is
   * authoritative and short-circuits with NO Overpass call — even when the store
   * result is empty (a sparse/filtered covered lookup is genuinely empty, not
   * un-imported). Omit `requestArea` to keep the plain empty→Overpass fallback.
   *
   * A non-connection store error (a missed migration, a PostGIS/SQL bug) is a
   * real defect `withPoiRepo` deliberately rethrows — surface it (500) rather
   * than mask it behind Overpass while `/poi/health`'s `SELECT 1` stays green.
   */
  private async readStoreFirst<T extends { external_id: string }>(
    fromStore: () => Promise<T[]>,
    fromProvider: () => Promise<T[]>,
    requestArea?: Bbox,
  ): Promise<T[]> {
    let stored: T[] | null = null;
    try {
      stored = await fromStore();
    } catch (err) {
      // Only a store outage falls back; a real bug surfaces.
      if (!(err instanceof ServiceUnavailableException)) throw err;
      this.logger.warn(
        `POI store unavailable, falling back to provider: ${err.message}`,
      );
    }
    // Coverage-aware fallback (#925): a fully-covered area is authoritative —
    // return the store result even when it's EMPTY, because a sparse or
    // kind-/min_stars-filtered lookup inside imported coverage is genuinely
    // empty, NOT un-imported, so it must not keep hitting Overpass. Only when the
    // area isn't fully covered (a request straddling the import frontier) do we
    // MERGE the store's covered-side rows with a live Overpass query for the
    // uncovered side (store rows win, richer decision-support), instead of
    // treating the covered side as complete and dropping the rest.
    if (stored !== null && requestArea) {
      if (await this.isCovered(requestArea)) return stored;
      const live = await this.fromProviderSafe(fromProvider);
      return mergeByExternalId(stored, live);
    }
    // No `requestArea` (coverage unknown) or the store failed: the original
    // store-first contract — store rows if any, else Overpass.
    if (stored !== null && stored.length > 0) return stored;
    return this.fromProviderSafe(fromProvider);
  }

  /**
   * Whether the request area is fully within a single imported region (#925).
   * Conservative: a request straddling two imported regions isn't "contained" in
   * either, so it falls through to a (harmless) Overpass merge — but one
   * straddling the OUTER edge of coverage never treats the store as complete.
   *
   * A transient POI-store outage during the coverage lookup itself (the store
   * dropped between `fromStore()` and here) resolves to `false` = "not
   * covered" (#925 review), so `readStoreFirst` merges with Overpass rather than
   * 500ing an otherwise-answerable read. A real (non-connection) defect still
   * surfaces, same as the primary store read.
   */
  private async isCovered(area: Bbox): Promise<boolean> {
    try {
      const covered = await this.store.importedRegionBboxes();
      return covered.some((region) => bboxContains(region, area));
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        this.logger.warn(
          `POI coverage lookup unavailable, treating as un-covered: ${err.message}`,
        );
        return false;
      }
      throw err;
    }
  }

  /** Overpass call that degrades to `[]` on failure (an offline provider never
   * fails a store-backed read). */
  private async fromProviderSafe<T>(
    fromProvider: () => Promise<T[]>,
  ): Promise<T[]> {
    try {
      return await fromProvider();
    } catch (err) {
      this.logger.warn(
        `POI provider failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  async findAccommodationsNear(
    lat: number,
    lng: number,
    radiusKm?: number,
    kinds?: AccommodationKind[],
    minStars?: number,
  ): Promise<AccommodationListDto> {
    const radius = this.clampRadiusKm(radiusKm);
    const resolvedKinds = this.resolveAccommodationKinds(kinds);
    const raw = await this.readStoreFirst(
      () =>
        this.store.findAccommodationsNear(
          lat,
          lng,
          radius,
          resolvedKinds,
          minStars,
        ),
      () => this.provider.findAccommodations(lat, lng, radius, resolvedKinds),
      pointRadiusBbox(lat, lng, radius),
    );
    return {
      accommodations: this.rank(raw, lat, lng, resolvedKinds, minStars),
      radius_km: radius,
      kinds: resolvedKinds,
    };
  }

  /**
   * Sort suggestions by "usefulness" = named-first, then by distance.
   * Nameless / contactless rows are kept, not dropped: every POI now
   * carries a `maps_url` (a Google Maps deep link from its coordinates),
   * so even an "Unnamed hotel" is navigable — the named-first sort just
   * ranks it after the ones that have a name.
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
      }));

    // Cross-source de-dup HERE, not in the store read (#869): `rank` recomputes
    // distance from the kept row's coordinates and slices globally, so de-duping
    // by coordinate upstream could drop a closer FSQ copy in favour of a farther
    // OSM twin that then falls outside MAX_RESULTS. Carry the group's minimum
    // anchor distance onto the kept OSM row. No-op for single-source reads.
    const deduped = dedupeAcrossSources(
      withDistance,
      (entry) => ({
        source: sourceOfExternalId(entry.poi.external_id),
        kind: entry.poi.kind,
        name: entry.poi.name,
        lat: entry.poi.lat,
        lng: entry.poi.lng,
      }),
      (kept, dropped) =>
        dropped.distance_km < kept.distance_km
          ? { ...kept, distance_km: dropped.distance_km }
          : kept,
    );

    deduped.sort((a, b) => {
      const aHasName = !!a.poi.name?.trim();
      const bHasName = !!b.poi.name?.trim();
      if (aHasName !== bHasName) return aHasName ? -1 : 1;
      return a.distance_km - b.distance_km;
    });

    return deduped.slice(0, MAX_RESULTS).map(({ poi, distance_km }) => ({
      external_id: poi.external_id,
      name: poi.name,
      kind: poi.kind,
      lat: poi.lat,
      lng: poi.lng,
      distance_km: Math.round(distance_km * 10) / 10,
      website: poi.website,
      phone: poi.phone,
      stars: poi.stars,
      opening_hours: poi.opening_hours,
      address_street: poi.address_street,
      address_city: poi.address_city,
      address_postcode: poi.address_postcode,
      address_country: poi.address_country,
      osm_url: osmDetailUrl(poi.external_id),
      maps_url: googleMapsUrl(poi.name, poi.lat, poi.lng),
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
    const raw = await this.readStoreFirst(
      () =>
        this.store.findPointsOfInterestNear(lat, lng, radius, resolvedKinds),
      () => this.provider.findPointsOfInterest(lat, lng, radius, resolvedKinds),
      pointRadiusBbox(lat, lng, radius),
    );
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
      }));

    // Cross-source de-dup HERE, not in the store read (#869): the ranker
    // recomputes distance from each kept row's coordinates and caps per kind, so
    // de-duping earlier (by coordinate, before distances exist) would let a
    // closer FSQ copy be replaced by a farther OSM twin that then sorts past the
    // cap — the venue would vanish though its group was inside it. Carry the
    // group's minimum anchor distance onto the kept OSM row so the sort + cap
    // rank the venue by its nearest member. No-op for single-source reads.
    const deduped = dedupeAcrossSources(
      withDistance,
      (entry) => ({
        source: sourceOfExternalId(entry.poi.external_id),
        kind: entry.poi.kind,
        name: entry.poi.name,
        lat: entry.poi.lat,
        lng: entry.poi.lng,
      }),
      (kept, dropped) =>
        dropped.distance_km < kept.distance_km
          ? { ...kept, distance_km: dropped.distance_km }
          : kept,
    );

    // Keep nameless / contactless rows: every POI now carries a `maps_url`
    // (a Google Maps deep link from its coordinates), so it's navigable even
    // without a name — the per-kind named-first sort below just ranks them
    // after named ones. Dropping them hid usable stops (e.g. unmanned fuel).
    const byKind = new Map<PoiKind, typeof withDistance>();
    for (const entry of deduped) {
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
      opening_hours: poi.opening_hours,
      address_street: poi.address_street,
      address_city: poi.address_city,
      address_postcode: poi.address_postcode,
      address_country: poi.address_country,
      cuisine: poi.cuisine,
      brand: poi.brand,
      osm_url: osmDetailUrl(poi.external_id),
      maps_url: googleMapsUrl(poi.name, poi.lat, poi.lng),
    }));
  }

  /**
   * Find POIs within a buffer of a route polyline — primary driver of
   * the mobile fuel-range warning (US-36) and the trip-day POI card.
   *
   * Algorithm:
   *   1. Walk the polyline, sampling anchors at exact `bufferKm`
   *      cumulative-km boundaries (interpolating inside segments rather
   *      than just picking vertices) so consecutive `around:` circles at
   *      the Overpass provider overlap even on sparse polylines.
   *   2. Query the provider once with all samples as centres.
   *   3. For each returned POI, project it onto its nearest route
   *      segment (closest point on segment, not nearest vertex). The
   *      perpendicular distance is its off-route distance; the cumulative
   *      distance to the projection is its along-route distance. Drop
   *      POIs farther than the buffer — the provider's union of circles
   *      can return points that are inside the nearest circle but outside
   *      the corridor we actually care about (e.g. a petrol station 2 km
   *      off a switchback).
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
    if (totalKm === undefined) {
      throw new Error('Cumulative length table is empty for a non-empty route');
    }

    // Store-first: the offline corridor read needs no anchor sampling (a
    // PostGIS ST_DWithin covers the whole line at once). Only when the store is
    // empty for this route (un-imported region) or unavailable do we sample
    // `around:` anchors and hit Overpass. Either way `rankAlongRoute` does the
    // perpendicular projection, so the corridor math is identical.
    const raw = await this.readStoreFirst(
      () =>
        this.store.findPointsOfInterestInCorridor(
          dto.route,
          bufferKm,
          resolvedKinds,
        ),
      () =>
        this.provider.findPointsOfInterestAroundPoints(
          sampleRouteAnchors(dto.route, cumKm, bufferKm),
          bufferKm,
          resolvedKinds,
        ),
      routeBufferBbox(dto.route, bufferKm),
    );

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
      // Keep nameless / contactless rows — `maps_url` makes them navigable,
      // which matters most here: unmanned fuel stops on a sparse route often
      // carry no name/website/phone yet are exactly what the fuel-range
      // warning needs to surface. Dropping them hid usable stops.
      // Project the POI onto the nearest polyline segment (closest point
      // on segment, not nearest vertex) so a station sitting halfway
      // along a long sparse segment is measured against the actual route
      // geometry rather than against whichever vertex happens to be
      // closest.
      const projected = projectOntoRoute(poi, route, cumKm);
      if (projected.distance_from_route_km > bufferKm) continue;

      const entry: Annotated = {
        poi,
        distance_along_route_km: projected.distance_along_route_km,
        distance_from_route_km: projected.distance_from_route_km,
      };
      const prev = deduped.get(poi.external_id);
      if (!prev || entry.distance_from_route_km < prev.distance_from_route_km) {
        deduped.set(poi.external_id, entry);
      }
    }

    // Cross-source de-dup AFTER the buffer filter (#869): among the
    // within-buffer survivors, drop an FSQ copy that duplicates an OSM one (same
    // kind, ~50 m, matching name), keeping OSM. Done here, not in the store
    // read, so a straddling OSM copy that projected outside the buffer can't
    // suppress the FSQ copy that projected inside. Source comes from the
    // external id since `PointOfInterest` carries none. No-op until FSQ imports.
    const survivors = dedupeAcrossSources(
      [...deduped.values()],
      (entry) => ({
        source: sourceOfExternalId(entry.poi.external_id),
        kind: entry.poi.kind,
        name: entry.poi.name,
        lat: entry.poi.lat,
        lng: entry.poi.lng,
      }),
      // Carry the closest copy's route distance onto the kept OSM row, so the
      // per-kind distance sort + cap below rank the venue by its nearest member.
      // Without this a closer FSQ copy replaced by a farther OSM twin could fall
      // outside the cap and vanish, even though the group was inside it.
      (kept, dropped) =>
        dropped.distance_from_route_km < kept.distance_from_route_km
          ? { ...kept, distance_from_route_km: dropped.distance_from_route_km }
          : kept,
    );

    const byKind = new Map<PoiKind, Annotated[]>();
    for (const entry of survivors) {
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
        opening_hours: poi.opening_hours,
        address_street: poi.address_street,
        address_city: poi.address_city,
        address_postcode: poi.address_postcode,
        address_country: poi.address_country,
        cuisine: poi.cuisine,
        brand: poi.brand,
        osm_url: osmDetailUrl(poi.external_id),
        maps_url: googleMapsUrl(poi.name, poi.lat, poi.lng),
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
 * Pick anchor points along the polyline at exact `bufferKm`-cumulative
 * boundaries such that a `bufferKm`-radius circle at each anchor covers
 * the entire route.
 *
 * Anchors are interpolated on the segment that spans each boundary
 * rather than snapped to the nearest existing vertex — on sparse
 * polylines (long segments between vertices) a vertex-only sampler
 * would leave gaps in the middle of those segments, dropping real
 * matches. The route start and end are always included so the corridor
 * doesn't trail off before the last vertex.
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
  const first = route[0];
  if (first === undefined) return [];
  if (route.length === 1) return [{ lat: first.lat, lng: first.lng }];

  const totalKm = cumKm[cumKm.length - 1];
  if (totalKm === undefined) {
    throw new Error('Cumulative length table is empty for a non-empty route');
  }
  const stride = Math.max(bufferKm, 0.5);

  const anchors: { lat: number; lng: number }[] = [
    { lat: first.lat, lng: first.lng },
  ];
  // Advance a cursor through segments and emit an anchor each time the
  // cumulative-km boundary `k * stride` crosses the current segment.
  // For a 200 km day at 2 km buffer this is ~100 samples — comfortably
  // under Overpass's soft 256-element `around:` limit.
  let segmentIdx = 1;
  for (let boundary = stride; boundary < totalKm; boundary += stride) {
    while (segmentIdx < route.length) {
      const cum = cumKm[segmentIdx];
      if (cum === undefined || cum >= boundary) break;
      segmentIdx++;
    }
    if (segmentIdx >= route.length) break;
    const segStartKm = cumKm[segmentIdx - 1];
    const segEndKm = cumKm[segmentIdx];
    const a = route[segmentIdx - 1];
    const b = route[segmentIdx];
    if (
      segStartKm === undefined ||
      segEndKm === undefined ||
      a === undefined ||
      b === undefined
    ) {
      throw new Error('Route/length index out of range while sampling anchors');
    }
    const segLenKm = segEndKm - segStartKm;
    const t = segLenKm > 0 ? (boundary - segStartKm) / segLenKm : 0;
    anchors.push({
      lat: a.lat + t * (b.lat - a.lat),
      lng: a.lng + t * (b.lng - a.lng),
    });
  }
  // Always include the final vertex so the tail of the route is covered
  // even when the stride hasn't landed exactly on it.
  const last = route[route.length - 1];
  const lastAnchor = anchors[anchors.length - 1];
  if (last === undefined || lastAnchor === undefined) {
    throw new Error('Route/anchor list unexpectedly empty while sampling');
  }
  if (lastAnchor.lat !== last.lat || lastAnchor.lng !== last.lng) {
    anchors.push({ lat: last.lat, lng: last.lng });
  }
  return anchors;
}

function roundKmTenth(km: number): number {
  return Math.round(km * 10) / 10;
}
