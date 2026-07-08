import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';
import type { AccommodationKind, PoiKind } from '@tarmoto/shared';
import type {
  AccommodationPoi,
  PointOfInterest,
} from './poi-provider.interface.js';
import { extractPoiHint } from './providers/overpass.provider.js';
import { googleMapsUrl, osmDetailUrl } from './poi-links.js';
import { cumulativeLengthKm, projectOntoRoute } from './poi-geo.js';
import { withPoiRepo } from './poi-repo.js';
import {
  DEFAULT_BUFFER_KM,
  MAX_BUFFER_KM,
} from './dto/point-of-interest.dto.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  StoredCorridorPoiDto,
  StoredPoiDto,
} from './dto/stored-poi.dto.js';

interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

interface RoutePoint {
  lat: number;
  lng: number;
}

/**
 * Read path over the offline `pois` store (#849). Unlike `PoiService` — which
 * hits Overpass live per request — this serves the mirrored PostGIS rows the
 * weekly import (#848 / #850) populates, so a pannable POI map layer and the
 * companion category bar don't hammer Overpass on every pan.
 *
 * Queries go through `createQueryBuilder` (not `repo.query`) so TypeORM
 * hydrates `geom` back into a GeoJSON Point — same reason the passes service
 * does; a raw query would hand back a WKB hex string and `toStoredPoiDto`
 * would crash on `.coordinates`.
 */
@Injectable()
export class PoiStoreService {
  constructor(
    @InjectDataSource('poi')
    private readonly poiDataSource: DataSource,
  ) {}

  /**
   * Live readiness: `isInitialized` only records that TypeORM connected once (it
   * stays true after a runtime drop), so probe with a trivial query so
   * `/poi/health` reflects the store's ACTUAL current connectivity (ADR 0007).
   */
  async isReady(): Promise<boolean> {
    if (!this.poiDataSource.isInitialized) return false;
    try {
      await this.poiDataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List stored POIs whose point falls inside the bounding box, optionally
   * filtered to a set of `kind`s, capped at `limit`. Ordered by kind then
   * name so the client can group markers deterministically.
   */
  async findInBbox(
    bbox: Bbox,
    kinds: string[] | undefined,
    limit: number,
  ): Promise<StoredPoiDto[]> {
    if (bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) {
      throw new BadRequestException(
        'bbox min must be strictly less than max on both axes',
      );
    }
    const capped = Math.min(
      Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    const rows = await withPoiRepo(this.poiDataSource, async (repo) => {
      const qb = repo
        .createQueryBuilder('poi')
        // ST_Intersects is GiST-index-accelerated (it bbox-prefilters via the
        // spatial index), and for point geometry it's equivalent to a bbox test.
        .where(
          'ST_Intersects(poi.geom, ST_MakeEnvelope(:minLng, :minLat, :maxLng, :maxLat, 4326))',
          bbox,
        )
        // Never surface bulk-import tombstones (#850): a closed venue must drop
        // out of the store reads, not just carry a `deactivated_at` stamp.
        .andWhere('poi.deactivated_at IS NULL');
      if (kinds && kinds.length > 0) {
        qb.andWhere('poi.kind IN (:...kinds)', { kinds });
      }
      return qb
        .orderBy('poi.kind', 'ASC')
        .addOrderBy('poi.name', 'ASC')
        .limit(capped)
        .getMany();
    });
    return rows.map(toStoredPoiDto);
  }

  /** Fetch a single stored POI by its uuid, or null when it doesn't exist. */
  async findById(id: string): Promise<StoredPoiDto | null> {
    const poi = await withPoiRepo(this.poiDataSource, (repo) =>
      // `deactivated_at: IsNull()` — a tombstoned (closed) POI reads as gone.
      repo.findOne({ where: { id, deactivated_at: IsNull() } }),
    );
    return poi ? toStoredPoiDto(poi) : null;
  }

  /**
   * Stored POIs within `bufferKm` of a route polyline (the STOPS tab, #849) —
   * the offline-store counterpart to the live `/poi/along-route`. Filters with
   * a PostGIS geography `ST_DWithin` corridor, then projects each hit onto the
   * route (reusing the live projection) for its along/off-route distances, and
   * sorts start→end. Returns the clamped buffer so the client can echo it.
   */
  async findAlongRoute(
    route: ReadonlyArray<RoutePoint>,
    kinds: string[] | undefined,
    bufferKm: number | undefined,
  ): Promise<{ pois: StoredCorridorPoiDto[]; buffer_km: number }> {
    if (route.length < 2) {
      throw new BadRequestException('Route must have at least 2 points');
    }
    const buffer = Math.min(
      Math.max(0.5, bufferKm || DEFAULT_BUFFER_KM),
      MAX_BUFFER_KM,
    );
    const rows = await this.queryCorridorEntities(route, buffer, kinds);

    // Project each hit onto the nearest route segment for its along/off-route
    // distances; drop anything the precise perpendicular puts beyond the buffer
    // (the geography corridor is slightly looser), sort start→end, cap.
    const cumKm = cumulativeLengthKm(route);
    const annotated = rows
      .map((poi) => {
        const [lng, lat] = poi.geom.coordinates;
        if (lng === undefined || lat === undefined) return null;
        return { poi, projected: projectOntoRoute({ lat, lng }, route, cumKm) };
      })
      .filter(
        (x): x is { poi: Poi; projected: ProjectedDistances } => x !== null,
      )
      .filter((x) => x.projected.distance_from_route_km <= buffer)
      .sort(
        (a, b) =>
          a.projected.distance_along_route_km -
          b.projected.distance_along_route_km,
      )
      .slice(0, MAX_LIMIT);

    return {
      buffer_km: buffer,
      pois: annotated.map(({ poi, projected }) => ({
        ...toStoredPoiDto(poi),
        distance_along_route_km:
          Math.round(projected.distance_along_route_km * 10) / 10,
        distance_from_route_km:
          Math.round(projected.distance_from_route_km * 10) / 10,
      })),
    };
  }

  /**
   * Stored POIs within `radiusKm` of a point, as the provider's raw
   * {@link PointOfInterest} shape (#849) — the store-first source for the live
   * `/poi/nearby`. Returns the raw hits (kind-filtered, tombstones excluded,
   * nearest-first, capped) for `PoiService` to rank / cap / map exactly as it
   * does Overpass results, so the store and live paths share one contract.
   */
  async findPointsOfInterestNear(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: PoiKind[],
  ): Promise<PointOfInterest[]> {
    const rows = await this.queryRadiusEntities(lat, lng, radiusKm, kinds);
    return rows.map(storedPoiToPointOfInterest);
  }

  /**
   * Stored accommodations within `radiusKm` of a point, as the provider's raw
   * {@link AccommodationPoi} shape (#849) — the store-first source for the live
   * `/poi/accommodations`. `minStars` filtering + ranking stay in
   * `PoiService.rank`, so store and live share one filter/sort contract.
   */
  async findAccommodationsNear(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: AccommodationKind[],
  ): Promise<AccommodationPoi[]> {
    const rows = await this.queryRadiusEntities(lat, lng, radiusKm, kinds);
    return rows.map(storedPoiToAccommodationPoi);
  }

  /**
   * Stored POIs within `bufferKm` of a route polyline, as raw
   * {@link PointOfInterest}s (#849) — the store-first source for the live
   * `/poi/along-route`. Returns the corridor hits unprojected; `PoiService`'s
   * `rankAlongRoute` does the perpendicular projection + along/off-route
   * distances (the same math the live path uses), so the corridor projection
   * is preserved and store/live outputs match in shape.
   */
  async findPointsOfInterestInCorridor(
    route: ReadonlyArray<RoutePoint>,
    bufferKm: number,
    kinds: PoiKind[],
  ): Promise<PointOfInterest[]> {
    if (route.length < 2) {
      throw new BadRequestException('Route must have at least 2 points');
    }
    const rows = await this.queryCorridorEntities(route, bufferKm, kinds);
    return rows.map(storedPoiToPointOfInterest);
  }

  /**
   * Rows whose point is within `radiusKm` of (lat,lng): kind-filtered, live
   * (non-tombstoned), nearest-first, capped at `MAX_LIMIT`. Shared by the
   * nearby-POI + accommodation store reads. Uses a geography `ST_DWithin` (the
   * passes-module pattern) so `radiusKm` is real metres-on-the-sphere, and
   * caps + orders by distance so a dense-city radius can't load unbounded rows.
   */
  private async queryRadiusEntities(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: string[] | undefined,
  ): Promise<Poi[]> {
    const radiusM = Math.round(Math.max(0, radiusKm) * 1000);
    // Bind lat/lng as named params (never string-interpolated) and reuse the
    // point in the distance sort. Query-builder (not raw) hydrates `geom`.
    const point = 'ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography';
    const params = { lat, lng, radius: radiusM };
    return withPoiRepo(this.poiDataSource, (repo) => {
      const qb = repo
        .createQueryBuilder('poi')
        .where(`ST_DWithin(poi.geom::geography, ${point}, :radius)`, params)
        .andWhere('poi.deactivated_at IS NULL');
      if (kinds && kinds.length > 0) {
        qb.andWhere('poi.kind IN (:...kinds)', { kinds });
      }
      return qb
        .orderBy(`ST_Distance(poi.geom::geography, ${point})`, 'ASC')
        .limit(MAX_LIMIT)
        .getMany();
    });
  }

  /**
   * Rows within `bufferKm` of a route polyline: kind-filtered + live. Factored
   * from {@link findAlongRoute} so the store-first corridor read and the
   * `/poi/in-corridor` endpoint share one geography `ST_DWithin` query; the
   * caller does any projection / sort. `bufferKm` is pre-clamped by the caller.
   */
  private async queryCorridorEntities(
    route: ReadonlyArray<RoutePoint>,
    bufferKm: number,
    kinds: string[] | undefined,
  ): Promise<Poi[]> {
    const bufferM = Math.round(bufferKm * 1000);
    // Build the LineString via named params so user coordinates are never
    // string-interpolated into SQL — same pattern as passes.checkRoute. Going
    // through the query builder also hydrates `geom` back into a GeoJSON Point.
    const params: Record<string, number> = { buffer: bufferM };
    const pointsSql = route
      .map((p, i) => {
        params[`lng${i}`] = p.lng;
        params[`lat${i}`] = p.lat;
        return `ST_MakePoint(:lng${i}, :lat${i})`;
      })
      .join(',');
    return withPoiRepo(this.poiDataSource, (repo) => {
      const qb = repo.createQueryBuilder('poi').where(
        `ST_DWithin(
          poi.geom::geography,
          ST_SetSRID(ST_MakeLine(ARRAY[${pointsSql}]), 4326)::geography,
          :buffer
        )`,
        params,
      );
      // Exclude bulk-import tombstones (#850) from the corridor read too.
      qb.andWhere('poi.deactivated_at IS NULL');
      if (kinds && kinds.length > 0) {
        qb.andWhere('poi.kind IN (:...kinds)', { kinds });
      }
      return qb.getMany();
    });
  }
}

interface ProjectedDistances {
  distance_from_route_km: number;
  distance_along_route_km: number;
}

/**
 * Map a persisted `Poi` row to the served DTO: reads lat/lng out of the
 * hydrated GeoJSON point, derives the OSM detail link, and serialises the
 * import timestamp. Exported for unit tests.
 */
export function toStoredPoiDto(poi: Poi): StoredPoiDto {
  const [lng, lat] = geomLngLat(poi);
  return {
    id: poi.id,
    source: poi.source,
    external_id: poi.external_id,
    name: poi.name,
    kind: poi.kind,
    lat,
    lng,
    website: poi.website,
    phone: poi.phone,
    opening_hours: poi.opening_hours,
    address_street: poi.address_street,
    address_city: poi.address_city,
    address_postcode: poi.address_postcode,
    address_country: poi.address_country,
    cuisine: poi.cuisine,
    brand: poi.brand,
    stars: poi.stars,
    osm_url: osmDetailUrl(poi.external_id),
    maps_url: googleMapsUrl(poi.name, lat, lng),
    last_imported_at: poi.last_imported_at.toISOString(),
  };
}

/** Read the hydrated GeoJSON point's `[lng, lat]`, guarding a corrupt row. */
function geomLngLat(poi: Poi): [number, number] {
  const [lng, lat] = poi.geom.coordinates;
  if (lng === undefined || lat === undefined) {
    throw new Error('stored POI geom is missing lng/lat');
  }
  return [lng, lat];
}

/**
 * Reproduce the live provider's `hint` for a stored POI. `cuisine` / `brand`
 * are denormalized columns byte-identical to `extractPoiHint`'s cuisine + fuel
 * branches (the import ran the same normalization), so read them directly; only
 * a viewpoint's `description` / `view_type` hint lives solely in the raw `tags`
 * bag, so derive that one via the shared `extractPoiHint`.
 */
function storedPoiHint(poi: Poi): string | null {
  if (poi.kind === 'viewpoint') {
    return extractPoiHint('viewpoint', poi.tags ?? {});
  }
  if (poi.kind === 'fuel_station') return poi.brand;
  return poi.cuisine;
}

/**
 * Map a stored `Poi` row to the provider's raw {@link PointOfInterest}, so a
 * store-first read feeds `PoiService`'s rankers exactly like Overpass does.
 * `kind` is cast to `PoiKind`: the caller only fetches rows whose `kind` is in
 * the requested live-enum set, so the superset values never reach here.
 * Exported for unit tests.
 */
export function storedPoiToPointOfInterest(poi: Poi): PointOfInterest {
  const [lng, lat] = geomLngLat(poi);
  return {
    external_id: poi.external_id,
    name: poi.name,
    kind: poi.kind as PoiKind,
    lat,
    lng,
    website: poi.website,
    phone: poi.phone,
    hint: storedPoiHint(poi),
    opening_hours: poi.opening_hours,
    address_street: poi.address_street,
    address_city: poi.address_city,
    address_postcode: poi.address_postcode,
    address_country: poi.address_country,
    cuisine: poi.cuisine,
    brand: poi.brand,
    tags: poi.tags,
  };
}

/**
 * Map a stored `Poi` row to the provider's raw {@link AccommodationPoi}. `kind`
 * is cast to `AccommodationKind` for the same reason as above. Exported for
 * unit tests.
 */
export function storedPoiToAccommodationPoi(poi: Poi): AccommodationPoi {
  const [lng, lat] = geomLngLat(poi);
  return {
    external_id: poi.external_id,
    name: poi.name,
    kind: poi.kind as AccommodationKind,
    lat,
    lng,
    website: poi.website,
    phone: poi.phone,
    stars: poi.stars,
    opening_hours: poi.opening_hours,
    address_street: poi.address_street,
    address_city: poi.address_city,
    address_postcode: poi.address_postcode,
    address_country: poi.address_country,
    cuisine: poi.cuisine,
    brand: poi.brand,
    tags: poi.tags,
  };
}
