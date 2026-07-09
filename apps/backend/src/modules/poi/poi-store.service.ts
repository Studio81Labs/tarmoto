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
import { cumulativeLengthKm, projectOntoRoute, type Bbox } from './poi-geo.js';
import { DEFAULT_REGIONS } from './poi-import.config.js';
import { withPoiRepo } from './poi-repo.js';
import { dedupeAcrossSources, type DedupPoi } from './poi-dedup.js';
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

interface RoutePoint {
  lat: number;
  lng: number;
}

/**
 * Per-kind cap for the store-first reads whose ranker is per-kind — the `nearby`
 * POI radius (`rankPois`) and the `along-route` corridor (`rankAlongRoute`)
 * (#849). Each kind is queried and bounded independently so a dense kind
 * (restaurants) can't fill a global nearest-first limit and crowd sparser kinds
 * (fuel, viewpoints) out — which `readStoreFirst` would then treat as
 * authoritative, so Overpass wouldn't backfill the dropped fuel stops the
 * fuel-range warning relies on. Comfortably above `PoiService`'s per-kind
 * display caps so the post-fetch ranking still has the true closest rows to
 * keep; total hydration stays bounded (this × the requested kinds). The
 * accommodation radius ranks globally (closest-N, any kind) so it keeps a
 * single global cap instead — with `min_stars` pushed into the query.
 */
const STORE_PER_KIND_LIMIT = 100;

/**
 * Over-fetch factor for the DB caps so cross-source de-dup (#869) doesn't let
 * duplicates consume the result budget: the `.limit()` runs before de-dup, so a
 * dense OSM+FSQ bbox could otherwise return far fewer than the cap once
 * duplicates are dropped. Fetch this multiple of the cap, then de-dup and trim
 * to the real cap. 2× covers the worst case (every kept row has one duplicate);
 * a no-op in effect when FSQ isn't imported.
 */
const DEDUP_OVERFETCH = 2;

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
   * Cache of the imported-region bboxes (#925). Imports run weekly, so a short
   * TTL keeps the coverage-aware read (`PoiService.readStoreFirst`) from running
   * a `DISTINCT import_region` scan on every request while still picking a
   * newly-imported region up within the window.
   */
  private coverageCache: { at: number; bboxes: Bbox[] } | null = null;
  private static readonly COVERAGE_TTL_MS = 60_000;

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
   * Bounding boxes of the regions the OSM bulk import has ACTUALLY populated
   * (#925): the `DISTINCT import_region` values (non-legacy, non-tombstoned)
   * mapped to their {@link DEFAULT_REGIONS} bbox. Drives the coverage-aware read
   * — a request that isn't fully inside one of these also queries Overpass, so
   * live coverage doesn't regress at import frontiers. Cached (see
   * {@link coverageCache}); a legacy (`import_region IS NULL`) or unknown-code
   * row contributes no bbox, so an area only counts as covered once imported.
   *
   * Scoped to `source = 'osm'` (#925 review): the Overpass fallback this
   * suppresses is OSM-backed, so an FSQ-only region (manual/scheduled FSQ import
   * before OSM has populated it) must NOT mark the bbox as covered — otherwise a
   * covered-empty read would skip the OSM Overpass fallback that should still run.
   */
  async importedRegionBboxes(): Promise<Bbox[]> {
    const now = Date.now();
    const cached = this.coverageCache;
    if (cached && now - cached.at < PoiStoreService.COVERAGE_TTL_MS) {
      return cached.bboxes;
    }
    const codes = await withPoiRepo(this.poiDataSource, (repo) =>
      repo
        .createQueryBuilder('poi')
        .select('DISTINCT poi.import_region', 'code')
        .where('poi.import_region IS NOT NULL')
        .andWhere('poi.deactivated_at IS NULL')
        .andWhere("poi.source = 'osm'")
        .getRawMany<{ code: string }>(),
    );
    const bboxByCode = new Map(DEFAULT_REGIONS.map((r) => [r.code, r.bbox]));
    const bboxes = codes
      .map((row) => bboxByCode.get(row.code))
      .filter((bbox): bbox is Bbox => bbox !== undefined);
    this.coverageCache = { at: now, bboxes };
    return bboxes;
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
        .limit(capped * DEDUP_OVERFETCH)
        .getMany();
    });
    // Over-fetch then trim to `capped` AFTER de-dup, so duplicates don't shrink
    // the result below the requested cap in a dense OSM+FSQ bbox.
    return dedupeAcrossSources(rows, poiDedupKey)
      .slice(0, capped)
      .map(toStoredPoiDto);
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
    // Bound the corridor read at the DB so a wide buffer (up to MAX_BUFFER_KM,
    // now 20 km) over a long route can't hydrate unbounded rows. Cap PER KIND
    // (closest-to-route first) when kinds are given, so a dense kind
    // (restaurants) can't fill a single global cap and crowd out sparser
    // selected kinds (fuel, campgrounds) — the fairness the store-first path
    // uses. An all-kinds request has no list to partition, so it falls back to a
    // single global MAX_LIMIT read. The along-route sort + slice below then
    // order/trim whatever these return.
    const fetched =
      kinds && kinds.length > 0
        ? (
            await Promise.all(
              kinds.map((kind) =>
                this.queryCorridorEntities(
                  route,
                  buffer,
                  [kind],
                  STORE_PER_KIND_LIMIT,
                ),
              ),
            )
          ).flat()
        : await this.queryCorridorEntities(route, buffer, kinds, MAX_LIMIT);
    // Project each hit onto the nearest route segment for its along/off-route
    // distances; drop anything the precise perpendicular puts beyond the buffer
    // (the geography corridor is slightly looser).
    const cumKm = cumulativeLengthKm(route);
    const withinBuffer = fetched
      .map((poi) => {
        const [lng, lat] = poi.geom.coordinates;
        if (lng === undefined || lat === undefined) return null;
        return { poi, projected: projectOntoRoute({ lat, lng }, route, cumKm) };
      })
      .filter(
        (x): x is { poi: Poi; projected: ProjectedDistances } => x !== null,
      )
      .filter((x) => x.projected.distance_from_route_km <= buffer);
    // De-dupe AFTER the precise buffer filter, not before: an OSM copy that
    // projects just OUTSIDE the buffer must not suppress an FSQ copy of the same
    // venue that projects inside, or the stop would vanish entirely. De-dupe the
    // survivors (keeping OSM), then sort start→end and cap. No-op until FSQ is
    // imported.
    const deduped = dedupeAcrossSources(withinBuffer, (x) =>
      poiDedupKey(x.poi),
    );
    // Trim the DEDUP_OVERFETCH headroom back to the real cap BEFORE the
    // route-order sort, so the doubled fetch can't change which rows show on an
    // OSM-only read (de-dup no-op). Both branches carry the rows nearest-to-route
    // first here (the per-kind and all-kinds queries both order by ST_Distance to
    // the line), so trimming keeps the closest:
    //  - per kind: STORE_PER_KIND_LIMIT each, so one dense kind can't crowd
    //    sparser ones out of the along-route sort below;
    //  - all kinds: the global MAX_LIMIT nearest-to-route — otherwise sorting all
    //    MAX_LIMIT×2 by route position and slicing MAX_LIMIT would keep the
    //    earliest-along-route, letting a far-off-route row displace a closer one.
    const trimmed =
      kinds && kinds.length > 0
        ? capPerKind(deduped, STORE_PER_KIND_LIMIT, (x) => x.poi.kind)
        : deduped.slice(0, MAX_LIMIT);
    const annotated = trimmed
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
    // Bound per kind (rankPois caps per kind) so a dense kind can't crowd out
    // sparser ones before ranking — see STORE_PER_KIND_LIMIT. Concurrent, so
    // it's one round-trip of latency.
    const perKind = await Promise.all(
      kinds.map((kind) =>
        this.queryRadiusEntities(
          lat,
          lng,
          radiusKm,
          [kind],
          STORE_PER_KIND_LIMIT,
        ),
      ),
    );
    // Cross-source de-dup is deferred to `PoiService.rankPois` — it recomputes
    // distance from each row's coordinates and caps per kind, so de-duping here
    // (by coordinate, before distances exist) could drop a closer FSQ copy for a
    // farther OSM twin that then sorts past the cap. The per-kind query already
    // bounds hydration at STORE_PER_KIND_LIMIT.
    return perKind.flat().map(storedPoiToPointOfInterest);
  }

  /**
   * Stored accommodations within `radiusKm` of a point, as the provider's raw
   * {@link AccommodationPoi} shape (#849) — the store-first source for the live
   * `/poi/accommodations`. Accommodations rank globally (closest-N, any kind),
   * so a single nearest-first cap is correct; `minStars` is pushed into the
   * query so an unrated cluster can't fill the cap and hide rated stays farther
   * out. `PoiService.rank` still applies the same filter to the Overpass path.
   */
  async findAccommodationsNear(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: AccommodationKind[],
    minStars?: number,
  ): Promise<AccommodationPoi[]> {
    const rows = await this.queryRadiusEntities(
      lat,
      lng,
      radiusKm,
      kinds,
      MAX_LIMIT,
      minStars,
    );
    // Cross-source de-dup is deferred to `PoiService.rank` — it recomputes
    // distance from each row's coordinates and slices globally, so de-duping here
    // could drop a closer FSQ copy for a farther OSM twin that then falls outside
    // the display cap. The query already bounds hydration at MAX_LIMIT.
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
    // Bound per kind, not globally — one closest-to-route query per kind — so a
    // dense kind can't crowd sparser ones out before `rankAlongRoute`'s own
    // per-kind cap (see STORE_PER_KIND_LIMIT). Runs the per-kind
    // queries concurrently, so it's one round-trip of latency.
    const perKind = await Promise.all(
      kinds.map((kind) =>
        this.queryCorridorEntities(
          route,
          bufferKm,
          [kind],
          STORE_PER_KIND_LIMIT,
        ),
      ),
    );
    // Cross-source de-dup is deferred to `PoiService.rankAlongRoute` — it runs
    // AFTER the precise per-route buffer filter, so an OSM copy that projects
    // just outside the buffer can't suppress an FSQ copy that projects inside.
    return perKind.flat().map(storedPoiToPointOfInterest);
  }

  /**
   * Rows whose point is within `radiusKm` of (lat,lng): kind-filtered, live
   * (non-tombstoned), nearest-first, capped at `limit`, optionally star-filtered.
   * Shared by the nearby-POI (per-kind cap) + accommodation (global cap +
   * `minStars`) store reads. Uses a geography `ST_DWithin` (the passes-module
   * pattern) so `radiusKm` is real metres-on-the-sphere, and caps + orders by
   * distance so a dense-city radius can't load unbounded rows.
   */
  private async queryRadiusEntities(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: string[] | undefined,
    limit: number,
    minStars?: number,
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
      // Push `min_stars` into the query so an unrated cluster can't fill the cap
      // and starve rated accommodations (NULL stars fail `>=`, matching
      // `PoiService.rank`'s "no rating → drop when min_stars set").
      if (minStars !== undefined) {
        qb.andWhere('poi.stars >= :minStars', { minStars });
      }
      // No DEDUP_OVERFETCH here: both radius callers now de-dup in the ranker
      // (which recomputes distance), so the store just bounds hydration at the
      // real cap — comfortably above the tiny display caps rankPois/rank apply.
      return qb
        .orderBy(`ST_Distance(poi.geom::geography, ${point})`, 'ASC')
        .limit(limit)
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
    limit?: number,
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
    const line = `ST_SetSRID(ST_MakeLine(ARRAY[${pointsSql}]), 4326)::geography`;
    return withPoiRepo(this.poiDataSource, (repo) => {
      const qb = repo
        .createQueryBuilder('poi')
        .where(`ST_DWithin(poi.geom::geography, ${line}, :buffer)`, params);
      // Exclude bulk-import tombstones (#850) from the corridor read too.
      qb.andWhere('poi.deactivated_at IS NULL');
      if (kinds && kinds.length > 0) {
        qb.andWhere('poi.kind IN (:...kinds)', { kinds });
      }
      // Bound every corridor read at the DB — closest-to-route first — so a
      // dense urban corridor or a wide buffer can't hydrate thousands of rows.
      // Callers cap per kind (STORE_PER_KIND_LIMIT) so one dense kind can't
      // crowd out sparser ones; an all-kinds `findAlongRoute` read has no list
      // to partition and falls back to a single global MAX_LIMIT cap.
      if (limit !== undefined) {
        qb.orderBy(`ST_Distance(poi.geom::geography, ${line})`, 'ASC').limit(
          limit * DEDUP_OVERFETCH,
        );
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

/** Project a stored `Poi` to its cross-source de-dup key (#869). */
function poiDedupKey(poi: Poi): DedupPoi {
  const [lng, lat] = geomLngLat(poi);
  return { source: poi.source, kind: poi.kind, name: poi.name, lat, lng };
}

/**
 * Trim the {@link DEDUP_OVERFETCH} headroom back to the real per-kind cap after
 * de-dup (#869). The DB fetched `cap × DEDUP_OVERFETCH` rows so cross-source
 * de-dup couldn't shrink a dense OSM+FSQ kind below `cap`; when there are no
 * duplicates (e.g. an OSM-only store) that headroom must NOT inflate the
 * single-source result past `cap`, or the rankers would see twice the intended
 * candidates. Rows arrive nearest-first within each kind, so keeping the first
 * `cap` of each kind keeps the closest.
 */
function capPerKind<T>(
  rows: T[],
  cap: number,
  kindOf: (row: T) => string,
): T[] {
  const counts = new Map<string, number>();
  return rows.filter((row) => {
    const kind = kindOf(row);
    const n = counts.get(kind) ?? 0;
    if (n >= cap) return false;
    counts.set(kind, n + 1);
    return true;
  });
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
