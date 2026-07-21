import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import {
  CheckRouteClosuresDto,
  CheckRouteClosuresResponseDto,
  ClosurePointDto,
  CreateClosureDto,
  ListClosuresQueryDto,
  RoadClosureDto,
  RoadClosureSeverity,
  UpdateClosureDto,
} from './dto/closures.dto.js';

// Sort ranking for severity so the highest-impact closures appear first.
const SEVERITY_RANK: Record<RoadClosureSeverity, number> = {
  full: 0,
  partial: 1,
  advisory: 2,
};

/**
 * Metres each `full` closure is buffered by when turned into a routing
 * `exclude_polygon` (#744). Tight on purpose: we want to exclude the
 * closed carriageway itself, not a wide swathe that would also block
 * parallel open roads.
 */
const EXCLUSION_BUFFER_M = 25;
const MAX_CLOSURE_LIST_RESULTS = 500;
const MAX_ROUTE_CLOSURE_RESULTS = 200;
const MAX_EXCLUSION_POLYGONS = 100;

interface BboxCoords {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

interface RouteClosureCountRow {
  full_count?: string | number;
  partial_count?: string | number;
  advisory_count?: string | number;
}

@Injectable()
export class ClosuresService {
  constructor(
    @InjectRepository(RoadClosure)
    private readonly repo: Repository<RoadClosure>,
    private readonly featureResolver: FeatureResolver,
  ) {}

  async list(query: ListClosuresQueryDto): Promise<RoadClosureDto[]> {
    const qb = this.repo
      .createQueryBuilder('c')
      // The public list is capped below, so rank safety-critical rows before
      // recency. Otherwise a dense historical/viewport query could fill the
      // budget with newer advisories and omit an older full closure.
      .orderBy(
        "CASE c.severity WHEN 'full' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END",
        'ASC',
      )
      .addOrderBy('c.starts_at', 'DESC');

    // Undecoded Alert-C/OpenLR feed rows (#743) have no geometry — never
    // surface them: they can't be rendered and `toDto` would crash on a
    // null `geom`. And a feed row the reconcile pass deactivated (dropped
    // from the snapshot) is kept for audit but is NOT public — this filter
    // is unconditional, so `include_past` can't expose inactive feed
    // history. (Inactive history would belong behind an admin endpoint.)
    qb.andWhere('c.geom IS NOT NULL').andWhere('c.is_active = true');

    // Operator kill switch: `road_closures` is a MIXED-SOURCE table —
    // 'official' is the NAP/DATEX feed's source value (see `nap.config`'s
    // `source: 'official'`), while 'operator'/'osm' rows are independently
    // entered/imported. A disable must hide only NAP-sourced closures, not
    // an operator's own manually-entered ones — so we filter them out
    // rather than short-circuiting to `[]`. Independent of
    // sys_nap_routing_avoidance below: an operator can kill display while
    // keeping (or vice versa) closures still routed around.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_nap_conditions'))
    ) {
      qb.andWhere("c.source != 'official'");
    }

    if (query.bbox) {
      const parsed = this.parseBbox(query.bbox);
      qb.andWhere(
        'ST_Intersects(c.geom, ST_MakeEnvelope(:minLng, :minLat, :maxLng, :maxLat, 4326))',
        parsed,
      );
    }

    // "include_past" opts out of ONLY the active-on time-window filter —
    // the default is to return closures in effect right now so the planner
    // map never shows history.
    if (!query.include_past) {
      const activeOn = query.active_on ? new Date(query.active_on) : new Date();
      qb.andWhere('c.starts_at <= :activeOn', { activeOn }).andWhere(
        '(c.ends_at IS NULL OR c.ends_at >= :activeOn)',
        { activeOn },
      );
    }

    if (query.severity) {
      qb.andWhere('c.severity = :severity', { severity: query.severity });
    }
    if (query.reason) {
      qb.andWhere('c.reason = :reason', { reason: query.reason });
    }

    const rows = await qb.limit(MAX_CLOSURE_LIST_RESULTS).getMany();
    return rows.map((r) => this.toDto(r));
  }

  async checkRoute(
    dto: CheckRouteClosuresDto,
  ): Promise<CheckRouteClosuresResponseDto> {
    if (dto.route.length < 2) {
      throw new BadRequestException('Route must have at least 2 points');
    }
    const bufferM = dto.buffer_m ?? 100;
    const activeOn = dto.active_on ? new Date(dto.active_on) : new Date();

    // Build the LineString via TypeORM's named-parameter binding so each
    // coordinate is passed as a real SQL parameter (no string
    // interpolation of user input). Going through `createQueryBuilder`
    // rather than `repo.query` also makes TypeORM hydrate the `geom`
    // column back into a GeoJSON LineString — with raw `.query()` we'd
    // get a WKB hex string and `toDto` would crash on `r.geom.coordinates`.
    const params: Record<string, number | Date> = {
      buffer: bufferM,
      activeOn,
    };
    const pointsSql = dto.route
      .map((p, i) => {
        params[`lng${i}`] = p.lng;
        params[`lat${i}`] = p.lat;
        return `ST_MakePoint(:lng${i}, :lat${i})`;
      })
      .join(',');
    const line = `ST_SetSRID(ST_MakeLine(ARRAY[${pointsSql}]), 4326)`;
    params['bufferDeg'] = (bufferM / 111320) * 2;

    const qb = this.repo
      .createQueryBuilder('c')
      // Skip undecoded feed rows (no geometry) and any closure
      // deactivated by the reconcile pass (#743).
      .andWhere('c.geom IS NOT NULL')
      .andWhere('c.is_active = true')
      .andWhere(`ST_DWithin(c.geom, ${line}, :bufferDeg)`, params)
      .andWhere(
        `ST_DWithin(
          c.geom::geography,
          ${line}::geography,
          :buffer
        )`,
        params,
      )
      .andWhere('c.starts_at <= :activeOn', { activeOn })
      .andWhere('(c.ends_at IS NULL OR c.ends_at >= :activeOn)', { activeOn })
      // Apply the cap only after prioritising the safety-critical severities.
      // The response is sorted the same way below, but doing it in SQL ensures
      // a dense corridor cannot crowd full closures out with advisories.
      // Window counts are evaluated before LIMIT, keeping the response totals
      // exact without repeating the expensive spatial predicate in a second
      // aggregate query.
      .addSelect(
        "COUNT(*) FILTER (WHERE c.severity = 'full') OVER ()",
        'full_count',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE c.severity = 'partial') OVER ()",
        'partial_count',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE c.severity = 'advisory') OVER ()",
        'advisory_count',
      )
      .orderBy(
        "CASE c.severity WHEN 'full' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END",
        'ASC',
      )
      .addOrderBy('c.starts_at', 'DESC');

    // Same operator kill switch as `list`: `road_closures` is a
    // MIXED-SOURCE table, so a disable hides only NAP-sourced ('official')
    // rows from the route check — operator/osm closures on the route are
    // still reported.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_nap_conditions'))
    ) {
      qb.andWhere("c.source != 'official'");
    }

    const result = await qb
      .limit(MAX_ROUTE_CLOSURE_RESULTS)
      .getRawAndEntities<RouteClosureCountRow>();
    const rows = result.entities;
    const counts = result.raw[0];

    const closures = rows
      .map((r) => this.toDto(r))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    return {
      closures,
      full_count: Number(counts?.full_count ?? 0),
      partial_count: Number(counts?.partial_count ?? 0),
      advisory_count: Number(counts?.advisory_count ?? 0),
    };
  }

  /**
   * Buffered polygons for active **full** closures within `bbox`, for the
   * router to avoid (#744). Each result is one closure's outer ring as
   * `[lng, lat]` pairs (Valhalla `exclude_polygons` format). Only `full`
   * closures are hard-excluded; partial/advisory stay warn-only via
   * `checkRoute`. Bounded by `bbox` so a national closure set never bloats
   * a single route request.
   */
  async exclusionPolygons(
    bbox: BboxCoords,
    activeOn: Date = new Date(),
  ): Promise<Array<Array<[number, number]>>> {
    const qb = this.repo
      .createQueryBuilder('c')
      .select(
        'ST_AsGeoJSON(ST_Buffer(c.geom::geography, :buffer)::geometry)',
        'geojson',
      )
      .where('c.geom IS NOT NULL')
      .andWhere('c.is_active = true')
      .andWhere('c.severity = :full', { full: 'full' })
      .andWhere('c.starts_at <= :activeOn', { activeOn })
      .andWhere('(c.ends_at IS NULL OR c.ends_at >= :activeOn)', { activeOn })
      .andWhere(
        'ST_Intersects(c.geom, ST_MakeEnvelope(:minLng, :minLat, :maxLng, :maxLat, 4326))',
        bbox,
      )
      .orderBy('c.starts_at', 'DESC')
      .limit(MAX_EXCLUSION_POLYGONS)
      .setParameter('buffer', EXCLUSION_BUFFER_M);

    // Separate operator kill switch from sys_nap_conditions above: routing
    // avoidance can be disabled independently of closure display. Same
    // mixed-source rule as `list`/`checkRoute` — exclude only NAP-sourced
    // ('official') rows when off, so an operator's own full closures
    // (e.g. US-40) are still routed around.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled(
        'sys_nap_routing_avoidance',
      ))
    ) {
      qb.andWhere("c.source != 'official'");
    }

    const rows = await qb.getRawMany<{ geojson: string | null }>();

    const polygons: Array<Array<[number, number]>> = [];
    for (const row of rows) {
      if (!row.geojson) continue;
      const geom = JSON.parse(row.geojson) as
        | { type: 'Polygon'; coordinates: [number, number][][] }
        | { type: 'MultiPolygon'; coordinates: [number, number][][][] };
      // Buffering a line/point always yields a Polygon (or a MultiPolygon
      // for self-touching geometry); take each outer ring.
      if (geom.type === 'Polygon') {
        if (geom.coordinates[0]) polygons.push(geom.coordinates[0]);
      } else {
        for (const poly of geom.coordinates) {
          if (poly[0]) polygons.push(poly[0]);
        }
      }
    }
    return polygons;
  }

  async getById(id: string): Promise<RoadClosureDto> {
    const row = await this.repo.findOne({ where: { id } });
    // Detail lookups must match the live list/route-check paths: hide
    // undecoded feed rows (no geometry — `RoadClosureDto.geometry` is
    // required and `toDto` reads `geom.coordinates`) AND rows the
    // reconcile pass deactivated (dropped from the feed snapshot), so a
    // cached/bookmarked URL can't surface a stale closure the map hides
    // (#743). Inactive history belongs behind an explicit admin path.
    if (!row || row.geom === null || row.is_active === false) {
      throw new NotFoundException('Closure not found');
    }
    // Same operator kill switch as `list`/`checkRoute`: `road_closures` is
    // a MIXED-SOURCE table, so a killed NAP display 404s only a
    // NAP-sourced ('official') closure — an operator/osm closure's detail
    // URL stays reachable. Checking `row.source` first also skips the
    // switch read entirely for the common (non-NAP) case.
    if (
      row.source === 'official' &&
      !(await this.featureResolver.isSystemSwitchEnabled('sys_nap_conditions'))
    ) {
      throw new NotFoundException('Closure not found');
    }
    return this.toDto(row);
  }

  async create(userId: string, dto: CreateClosureDto): Promise<RoadClosureDto> {
    const starts = new Date(dto.starts_at);
    const ends = dto.ends_at ? new Date(dto.ends_at) : null;
    this.assertWindow(starts, ends);
    if (dto.detour !== undefined && dto.reason !== 'roadworks') {
      throw new BadRequestException(
        'detour is only allowed when reason = "roadworks"',
      );
    }

    const entity = this.repo.create({
      title: dto.title,
      reason: dto.reason,
      severity: dto.severity,
      geom: this.toLineString(dto.geometry),
      detour_geom: dto.detour ? this.toLineString(dto.detour) : null,
      country_code: dto.country_code.toUpperCase(),
      region: dto.region ?? null,
      starts_at: starts,
      ends_at: ends,
      notes: dto.notes ?? null,
      source: 'operator',
      created_by: userId,
    });

    const saved = await this.repo.save(entity);
    return this.toDto(saved);
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateClosureDto,
  ): Promise<RoadClosureDto> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Closure not found');
    }
    // Operator-entered data only: the creator owns the record. This is
    // a deliberate MVP rule — when admin roles land, the check becomes
    // "creator OR admin".
    if (row.created_by !== userId) {
      throw new ForbiddenException('Only the creator can modify this closure');
    }

    if (dto.title !== undefined) row.title = dto.title;
    if (dto.reason !== undefined) row.reason = dto.reason;
    if (dto.severity !== undefined) row.severity = dto.severity;
    if (dto.geometry !== undefined) row.geom = this.toLineString(dto.geometry);
    if (dto.country_code !== undefined) {
      row.country_code = dto.country_code.toUpperCase();
    }
    if (dto.region !== undefined) row.region = dto.region;
    if (dto.starts_at !== undefined) row.starts_at = new Date(dto.starts_at);
    if (dto.ends_at !== undefined) {
      row.ends_at = dto.ends_at === null ? null : new Date(dto.ends_at);
    }
    if (dto.notes !== undefined) row.notes = dto.notes;
    if (dto.detour !== undefined) {
      row.detour_geom =
        dto.detour === null ? null : this.toLineString(dto.detour);
    }

    // Detours are a roadworks-only concept. If the resulting row would
    // still carry a detour under a different reason, reject — forcing
    // the caller to pass `detour: null` explicitly when they reclassify
    // a closure away from roadworks.
    if (row.detour_geom && row.reason !== 'roadworks') {
      throw new BadRequestException(
        'detour is only allowed when reason = "roadworks"',
      );
    }

    this.assertWindow(row.starts_at, row.ends_at);

    const saved = await this.repo.save(row);
    return this.toDto(saved);
  }

  async remove(id: string, userId: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Closure not found');
    }
    if (row.created_by !== userId) {
      throw new ForbiddenException('Only the creator can delete this closure');
    }
    await this.repo.remove(row);
  }

  // ── helpers ──

  private toDto(r: RoadClosure): RoadClosureDto {
    // Every caller filters/guards `geom IS NULL` (list, checkRoute,
    // getById) and create/update always set geometry, so a non-null geom
    // is an invariant here — undecoded feed rows (#743) never reach this.
    return {
      id: r.id,
      title: r.title,
      reason: r.reason,
      severity: r.severity,
      geometry: r.geom!.coordinates.map(([lng, lat]) => {
        if (lng === undefined || lat === undefined) {
          throw new Error('closure geometry coordinate is missing lng/lat');
        }
        return { lng, lat };
      }),
      detour: r.detour_geom
        ? r.detour_geom.coordinates.map(([lng, lat]) => {
            if (lng === undefined || lat === undefined) {
              throw new Error('closure detour coordinate is missing lng/lat');
            }
            return { lng, lat };
          })
        : null,
      country_code: r.country_code,
      region: r.region,
      starts_at: r.starts_at.toISOString(),
      ends_at: r.ends_at ? r.ends_at.toISOString() : null,
      notes: r.notes,
      source: r.source,
      created_by: r.created_by,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }

  private toLineString(points: ClosurePointDto[]): {
    type: 'LineString';
    coordinates: [number, number][];
  } {
    if (points.length < 2) {
      throw new BadRequestException('geometry must have at least 2 points');
    }
    return {
      type: 'LineString',
      coordinates: points.map((p) => [p.lng, p.lat] as [number, number]),
    };
  }

  private assertWindow(starts: Date, ends: Date | null): void {
    if (Number.isNaN(starts.getTime())) {
      throw new BadRequestException('starts_at is not a valid date');
    }
    if (ends !== null) {
      if (Number.isNaN(ends.getTime())) {
        throw new BadRequestException('ends_at is not a valid date');
      }
      if (ends.getTime() < starts.getTime()) {
        throw new BadRequestException('ends_at must be >= starts_at');
      }
    }
  }

  private parseBbox(bbox: string): BboxCoords {
    const parts = bbox.split(',').map((s) => Number.parseFloat(s));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      throw new BadRequestException(
        'bbox must be "minLng,minLat,maxLng,maxLat"',
      );
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (
      minLng === undefined ||
      minLat === undefined ||
      maxLng === undefined ||
      maxLat === undefined
    ) {
      throw new BadRequestException(
        'bbox must be "minLng,minLat,maxLng,maxLat"',
      );
    }
    if (minLng >= maxLng || minLat >= maxLat) {
      throw new BadRequestException(
        'bbox min must be strictly less than max for both axes',
      );
    }
    return { minLng, minLat, maxLng, maxLat };
  }
}
