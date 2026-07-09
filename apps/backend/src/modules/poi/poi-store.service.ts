import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';
import type { AccommodationKind, PoiKind } from '@tarmoto/shared';
import type {
  AccommodationPoi,
  PointOfInterest,
} from './poi-provider.interface.js';
import {
  classifyPoiTags,
  extractPoiHint,
  POI_KIND_TAGS,
} from './providers/overpass.provider.js';
import { googleMapsUrl, osmDetailUrl } from './poi-links.js';
import { cumulativeLengthKm, projectOntoRoute, type Bbox } from './poi-geo.js';
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
 * Coverage request shape for {@link PoiStoreService.isRequestCovered} (#944): a
 * radius disc (point + km) or a route corridor (polyline + buffer km). Mirrors
 * the two point-anchored / corridor read shapes the store already serves, so
 * each `PoiService` caller builds one straight from its own request params.
 */
export type CoverageDescriptor =
  | { kind: 'radius'; lat: number; lng: number; radiusKm: number }
  | {
      kind: 'route';
      route: readonly { lat: number; lng: number }[];
      bufferKm: number;
    };

function isFiniteLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/**
 * Full request-geometry SQL (buffered disc/corridor) + its positional params,
 * or null for a degenerate/invalid descriptor → treat as uncovered (#944).
 * `requestSql` bakes the buffer distance in with its own `$` placeholder, so
 * {@link PoiStoreService.isRequestCovered} just drops it straight into
 * `ST_Covers` — no separate index-prefilter juggling like the old point-probe
 * needed. Buffer distance is metric metres (`km * 1000`): `ST_Buffer` on a
 * `geography` measures in metres, then the result is cast back to `geometry`
 * so `ST_Covers` can compare it against the stored region polygon.
 */
function buildCoverageRequest(
  d: CoverageDescriptor,
): { requestSql: string; params: (string | number)[] } | null {
  if (d.kind === 'radius') {
    if (!isFiniteLatLng(d.lat, d.lng) || !Number.isFinite(d.radiusKm))
      return null;
    return {
      requestSql:
        'ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)::geometry',
      params: [d.lng, d.lat, Math.max(0, d.radiusKm) * 1000],
    };
  }
  const pts = d.route.filter((p) => isFiniteLatLng(p.lat, p.lng));
  if (pts.length === 0 || !Number.isFinite(d.bufferKm)) return null;
  // GeoJSON is [lng,lat]; a LineString needs >= 2 positions — duplicate a lone
  // point so a single-vertex route still buffers to a disc.
  const coords = pts.map((p) => [p.lng, p.lat]);
  if (coords.length === 1) coords.push(coords[0]!);
  const line = JSON.stringify({ type: 'LineString', coordinates: coords });
  return {
    requestSql:
      'ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)::geometry',
    params: [line, Math.max(0, d.bufferKm) * 1000],
  };
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
   * Whether `descriptor`'s request geometry (a radius disc or a buffered route
   * corridor) sits ENTIRELY inside a region the OSM bulk import has completed
   * (#944) — the coverage signal for {@link PoiService.readStoreFirst}. A single
   * `ST_Covers(region_polygon, buffered_request_geometry)` query against
   * `poi_import_regions`, gated on `imported_at IS NOT NULL` (Task 4 scopes that
   * stamp to OSM, matching the OSM-backed Overpass fallback this gates).
   *
   * Region MEMBERSHIP, not point PROXIMITY (#944): this replaces the #925
   * sample-probe (`bool_and(EXISTS(...))` over rim/rail points near imported
   * `pois` rows), whose point-radius shape reported a border wedge just outside
   * the real import boundary as covered (the "border halo" documented on the
   * old `COVERAGE_BUFFER_KM` constant, now removed). Testing the buffered
   * request against the region's actual boundary polygon is exact regardless
   * of rollout state.
   *
   * `buildCoverageRequest` returns null for a degenerate/non-finite descriptor
   * (NaN coordinates, an empty route) — that short-circuits to `false` (not
   * covered) WITHOUT running a query, same "unknown → not covered" contract the
   * old sample probe had for an empty sample list.
   */
  async isRequestCovered(descriptor: CoverageDescriptor): Promise<boolean> {
    const built = buildCoverageRequest(descriptor);
    if (built === null) return false; // non-finite / empty → not covered, no query
    const { requestSql, params } = built;
    const sql = `
      SELECT EXISTS (
        SELECT 1 FROM poi_import_regions r
        WHERE r.imported_at IS NOT NULL
          AND ST_Covers(r.geom, ${requestSql})
      ) AS covered`;
    return withPoiRepo(this.poiDataSource, async (repo) => {
      const rows = await repo.query<{ covered: boolean | null }[]>(sql, params);
      return rows[0]?.covered === true;
    });
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
        // Match the stored kind OR the venue tag (#926) so the pannable map layer
        // surfaces a dual-tagged element under a secondary-kind request too.
        const { sql, params: kindParams } = kindMatchClause(kinds, kinds);
        qb.andWhere(sql, kindParams);
        // Order EXACT stored-kind matches ahead of tag-only (secondary) matches
        // (#926 review): the DB `LIMIT` runs before reclassification, so in a
        // dense bbox the dual-tagged rows (which sort by their own stored kind,
        // e.g. `restaurant` < `viewpoint`) must not fill the cap and starve real
        // `kind = viewpoint` rows. `:kinds` is already bound above — TypeORM
        // substitutes params across the whole query, ORDER BY included.
        qb.orderBy(
          'CASE WHEN poi.kind IN (:...kinds) THEN 0 ELSE 1 END',
          'ASC',
        ).addOrderBy('poi.kind', 'ASC');
      } else {
        qb.orderBy('poi.kind', 'ASC');
      }
      return qb
        .addOrderBy('poi.name', 'ASC')
        .limit(capped * DEDUP_OVERFETCH)
        .getMany();
    });
    // Reclassify dual-tagged rows to the requested kind (#926) so the served
    // marker kind matches the live path, then over-fetch-trim to `capped` AFTER
    // de-dup so duplicates don't shrink the result below the cap in a dense
    // OSM+FSQ bbox.
    const reclassified =
      kinds && kinds.length > 0
        ? reclassifyByRequestedKinds(rows, kinds)
        : rows;
    return dedupeAcrossSources(reclassified, poiDedupKey)
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
                  kinds, // full set for the tag-match exclusion (#926 review)
                ),
              ),
            )
          ).flat()
        : await this.queryCorridorEntities(route, buffer, kinds, MAX_LIMIT);
    // Reclassify dual-tagged rows to the requested kind + de-dup by external_id
    // (#926) before projecting, so a `viewpoint` corridor query surfaces a
    // dual-tagged `restaurant` element as a viewpoint. `/poi/in-corridor` accepts
    // free-form stored kinds (e.g. `hotel`), so a requested stored kind is
    // preserved — reclassifyByRequestedKinds only relabels tag-only matches. An
    // all-kinds read needs no reclassify (stored kind is already the primary).
    const rows =
      kinds && kinds.length > 0
        ? reclassifyByRequestedKinds(fetched, kinds)
        : fetched;
    // Project each hit onto the nearest route segment for its along/off-route
    // distances; drop anything the precise perpendicular puts beyond the buffer
    // (the geography corridor is slightly looser).
    const cumKm = cumulativeLengthKm(route);
    const withinBuffer = rows
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
          undefined,
          kinds, // full set, so the tag-match excludes every requested kind
        ),
      ),
    );
    // Reclassify dual-tagged rows to the requested kind + de-dup by external_id
    // (#926), so a `viewpoint` request gets an `amenity=restaurant`+
    // `tourism=viewpoint` element as a viewpoint, matching the live path.
    // Cross-source de-dup is deferred to `PoiService.rankPois` — it recomputes
    // distance from each row's coordinates and caps per kind, so de-duping there
    // (not here) keeps a closer FSQ copy from being dropped for a farther OSM
    // twin. The per-kind query already bounds hydration at STORE_PER_KIND_LIMIT.
    return reclassifyByRequestedKinds(perKind.flat(), kinds).map(
      storedPoiToPointOfInterest,
    );
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
          kinds, // full set for the tag-match exclusion (#926 review)
        ),
      ),
    );
    // Reclassify dual-tagged rows to the requested kind + de-dup by external_id
    // (#926) before ranking, matching the live path. Cross-source de-dup is
    // deferred to `PoiService.rankAlongRoute` — it runs AFTER the precise
    // per-route buffer filter, so an OSM copy that projects just outside the
    // buffer can't suppress an FSQ copy that projects inside.
    return reclassifyByRequestedKinds(perKind.flat(), kinds).map(
      storedPoiToPointOfInterest,
    );
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
    // The full requested kind set (#926 review) — the per-kind fan-out passes a
    // single `kind`, but the secondary tag-match must exclude EVERY requested
    // kind so a dual-tagged element isn't tag-surfaced under one kind's budget
    // while already found by another's. Defaults to `kinds` for all-at-once reads.
    allKinds?: readonly string[],
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
        // Match the stored kind OR the venue tag (#926) — see kindMatchClause.
        const { sql, params: kindParams } = kindMatchClause(
          kinds,
          allKinds ?? kinds,
        );
        qb.andWhere(sql, kindParams);
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
    // Full requested kind set for the secondary tag-match (#926 review) — see
    // queryRadiusEntities. Defaults to `kinds` for the all-kinds corridor read.
    allKinds?: readonly string[],
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
        // Match the stored kind OR the venue tag (#926) — see kindMatchClause.
        const { sql, params: kindParams } = kindMatchClause(
          kinds,
          allKinds ?? kinds,
        );
        qb.andWhere(sql, kindParams);
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
 * The WHERE fragment for a venue store read's kind filter (#926). Matches the
 * stored primary `kind` OR — for a venue kind whose OSM classifier tag is known
 * ({@link POI_KIND_TAGS}) — the raw `tags` bag, so a dual-tagged element stored
 * under its amenity-first primary (`amenity=restaurant`+`tourism=viewpoint` →
 * stored `restaurant`) is still matched by a `viewpoint` request, matching the
 * live Overpass path. Kinds with no `POI_KIND_TAGS` entry (accommodations) get a
 * plain `kind IN`, so those reads are unchanged.
 *
 * The secondary tag-match is gated on `poi.kind NOT IN (:...kinds)` (#926
 * review): an element whose STORED kind was itself requested is already found by
 * its own kind query, so tag-matching it a second time would only consume that
 * other kind's per-kind budget (the `LIMIT` runs before reclassification) and
 * could starve real rows of that kind. Only elements whose primary kind wasn't
 * requested are surfaced by their secondary tag.
 */
function kindMatchClause(
  queryKinds: readonly string[],
  allRequestedKinds: readonly string[],
): {
  sql: string;
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {
    kinds: queryKinds,
    allKinds: allRequestedKinds,
  };
  const clauses = ['poi.kind IN (:...kinds)'];
  queryKinds.forEach((kind, i) => {
    // OWN properties only (#926 review): `/poi/in-corridor` takes free-form
    // stored kinds, so a value like `toString` or `constructor` would otherwise
    // read an inherited `Object.prototype` member — a truthy non-tag that builds
    // a `tags @> '{}'` clause matching essentially every POI.
    const tag = Object.hasOwn(POI_KIND_TAGS, kind)
      ? (POI_KIND_TAGS[kind as PoiKind] as { key: string; value: string })
      : undefined;
    if (!tag) return;
    params[`ktag${i}`] = JSON.stringify({ [tag.key]: tag.value });
    clauses.push(
      `(poi.tags @> :ktag${i}::jsonb AND poi.kind NOT IN (:...allKinds))`,
    );
  });
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/**
 * Reclassify venue store rows to the kind a `requestedKinds` query should serve
 * them under (#926), deduping by `external_id`.
 *
 * A row matched by its STORED kind (that kind was requested) keeps it: the
 * stored kind is the import's amenity-first primary, so it already matches the
 * live path's amenity-first-among-requested choice — order-independently — and,
 * crucially, a stored NON-venue kind (`hotel`, `camp_site`) is preserved rather
 * than run through the venue-only `classifyPoiTags`, which would ignore it and
 * mislabel a `/poi/in-corridor` accommodation (#926 review). Only a row surfaced
 * PURELY by a secondary venue tag — its stored kind wasn't requested (see
 * {@link kindMatchClause}) — is reclassified to that tag's kind. The served kind
 * flows through the row→DTO mappers, so the derived `hint` follows it too.
 */
function reclassifyByRequestedKinds(
  rows: readonly Poi[],
  requestedKinds: readonly string[],
): Poi[] {
  const requested = new Set(requestedKinds);
  const seen = new Set<string>();
  const out: Poi[] = [];
  for (const poi of rows) {
    if (seen.has(poi.external_id)) continue;
    seen.add(poi.external_id);
    if (requested.has(poi.kind)) {
      out.push(poi);
      continue;
    }
    const served =
      classifyPoiTags(poi.tags ?? {}, requestedKinds as readonly PoiKind[]) ??
      poi.kind;
    out.push(served === poi.kind ? poi : { ...poi, kind: served });
  }
  return out;
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
