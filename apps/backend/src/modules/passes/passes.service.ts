import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MountainPass } from '../../entities/mountain-pass.entity.js';
import {
  CheckRouteDto,
  CheckRouteResponseDto,
  MountainPassDto,
  MAX_LIST_PASSES_LIMIT,
  PassStatus,
} from './dto/passes.dto.js';

interface BboxCoords {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

interface RoutePassCountRow {
  closed_count?: string | number;
  unknown_count?: string | number;
}

const MAX_ROUTE_PASS_RESULTS = 200;

@Injectable()
export class PassesService {
  constructor(
    @InjectRepository(MountainPass)
    private readonly passRepo: Repository<MountainPass>,
  ) {}

  /**
   * Derive the rideable status of a pass at a given month.
   *
   * The window is INCLUSIVE on both ends (e.g. open=6, close=10 means
   * Jun, Jul, Aug, Sep, Oct are open). It also wraps across the new
   * year — open=11, close=3 covers Nov, Dec, Jan, Feb, Mar — which
   * keeps the helper honest for southern-hemisphere or low-altitude
   * passes that simply degrade in mid-summer.
   */
  static statusFromSchedule(
    openMonth: number,
    closeMonth: number,
    currentMonth: number,
  ): PassStatus {
    if (
      !Number.isInteger(openMonth) ||
      !Number.isInteger(closeMonth) ||
      !Number.isInteger(currentMonth) ||
      openMonth < 1 ||
      openMonth > 12 ||
      closeMonth < 1 ||
      closeMonth > 12 ||
      currentMonth < 1 ||
      currentMonth > 12
    ) {
      return 'unknown';
    }
    if (openMonth <= closeMonth) {
      return currentMonth >= openMonth && currentMonth <= closeMonth
        ? 'open'
        : 'closed';
    }
    // Wrap-around window (e.g. Nov→Mar).
    return currentMonth >= openMonth || currentMonth <= closeMonth
      ? 'open'
      : 'closed';
  }

  async list(
    bbox?: string,
    forMonth?: number,
    limit = MAX_LIST_PASSES_LIMIT,
    offset = 0,
  ): Promise<MountainPassDto[]> {
    const qb = this.passRepo
      .createQueryBuilder('p')
      .orderBy('p.name', 'ASC')
      .addOrderBy('p.id', 'ASC');

    if (bbox) {
      const parsed = this.parseBbox(bbox);
      qb.where(
        'ST_Intersects(p.location, ST_MakeEnvelope(:minLng, :minLat, :maxLng, :maxLat, 4326))',
        parsed,
      );
    }

    const rows = await qb.limit(limit).offset(offset).getMany();
    const month = this.resolveMonth(forMonth);
    return rows.map((p) => this.toDto(p, month));
  }

  async checkRoute(dto: CheckRouteDto): Promise<CheckRouteResponseDto> {
    if (dto.route.length < 2) {
      throw new BadRequestException('Route must have at least 2 points');
    }
    const bufferM = dto.buffer_m ?? 1500;
    const month = this.resolveMonth(dto.for_month);

    // Build the LineString via TypeORM's named-parameter binding so each
    // coordinate is passed as a real SQL parameter (no string
    // interpolation of user input). Going through `createQueryBuilder`
    // rather than `repo.query` also makes TypeORM hydrate the `location`
    // column back into a GeoJSON Point — with raw `.query()` we'd get
    // a WKB hex string and `toDto` would crash on `p.location.coordinates`.
    const params: Record<string, number> = {
      buffer: bufferM,
      statusMonth: month,
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

    // Keep aggregate status counts exact even when the response list is
    // capped below. The window expressions run over every spatial match
    // before LIMIT, avoiding a second traversal of the expensive route
    // predicate. This CASE deliberately mirrors `toDto`: an operator
    // override wins, otherwise the inclusive schedule (including windows
    // that wrap over New Year) determines the status.
    const statusSql = `CASE
      WHEN p.override_status IS NOT NULL THEN p.override_status
      WHEN p.typical_open_month NOT BETWEEN 1 AND 12
        OR p.typical_close_month NOT BETWEEN 1 AND 12 THEN 'unknown'
      WHEN (
        p.typical_open_month <= p.typical_close_month
        AND :statusMonth BETWEEN p.typical_open_month AND p.typical_close_month
      ) OR (
        p.typical_open_month > p.typical_close_month
        AND (
          :statusMonth >= p.typical_open_month
          OR :statusMonth <= p.typical_close_month
        )
      ) THEN 'open'
      ELSE 'closed'
    END`;
    const result = await this.passRepo
      .createQueryBuilder('p')
      .where(`ST_DWithin(p.location, ${line}, :bufferDeg)`, params)
      .andWhere(
        `ST_DWithin(
          p.location::geography,
          ${line}::geography,
          :buffer
        )`,
        params,
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE (${statusSql}) = 'closed') OVER ()`,
        'closed_count',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE (${statusSql}) = 'unknown') OVER ()`,
        'unknown_count',
      )
      .orderBy('p.elevation_m', 'DESC')
      .limit(MAX_ROUTE_PASS_RESULTS)
      .getRawAndEntities<RoutePassCountRow>();

    const passes: MountainPassDto[] = result.entities.map((p) =>
      this.toDto(p, month),
    );
    const counts = result.raw[0];

    return {
      passes,
      closed_count: Number(counts?.closed_count ?? 0),
      unknown_count: Number(counts?.unknown_count ?? 0),
    };
  }

  // ── helpers ──

  private currentMonthUtc(): number {
    return new Date().getUTCMonth() + 1;
  }

  /**
   * Pick the month to derive pass statuses for: caller-supplied value
   * when present and in range, otherwise the current UTC month. The DTO
   * already constrains `forMonth` to 1..12, but we re-check here so the
   * service stays safe if called from code that skipped DTO validation
   * (e.g. future internal consumers).
   */
  private resolveMonth(forMonth: number | undefined): number {
    if (
      forMonth !== undefined &&
      Number.isInteger(forMonth) &&
      forMonth >= 1 &&
      forMonth <= 12
    ) {
      return forMonth;
    }
    return this.currentMonthUtc();
  }

  private toDto(p: MountainPass, currentMonth: number): MountainPassDto {
    const overridden = p.override_status !== null;
    const status: PassStatus = overridden
      ? (p.override_status as PassStatus)
      : PassesService.statusFromSchedule(
          p.typical_open_month,
          p.typical_close_month,
          currentMonth,
        );

    const point = p.location;
    const [lng, lat] = point.coordinates;
    if (lng === undefined || lat === undefined) {
      throw new Error('pass location coordinate is missing lng/lat');
    }

    return {
      id: p.id,
      name: p.name,
      country_code: p.country_code,
      region: p.region,
      lat,
      lng,
      elevation_m: p.elevation_m,
      typical_open_month: p.typical_open_month,
      typical_close_month: p.typical_close_month,
      status,
      status_overridden: overridden,
      notes: p.notes,
      last_updated: p.last_updated.toISOString(),
    };
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
