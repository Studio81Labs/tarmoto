import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import {
  ClosurePointDto,
  CreateClosureDto,
  ListClosuresQueryDto,
  RoadClosureDto,
  UpdateClosureDto,
} from './dto/closures.dto.js';

interface BboxCoords {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

@Injectable()
export class ClosuresService {
  constructor(
    @InjectRepository(RoadClosure)
    private readonly repo: Repository<RoadClosure>,
  ) {}

  async list(query: ListClosuresQueryDto): Promise<RoadClosureDto[]> {
    const qb = this.repo.createQueryBuilder('c').orderBy('c.starts_at', 'DESC');

    if (query.bbox) {
      const parsed = this.parseBbox(query.bbox);
      qb.andWhere(
        'ST_Intersects(c.geom, ST_MakeEnvelope(:minLng, :minLat, :maxLng, :maxLat, 4326))',
        parsed,
      );
    }

    // "include_past" opts out of the active-on filter entirely — the
    // default is to only return closures in effect right now so the
    // planner map never shows history.
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

    const rows = await qb.getMany();
    return rows.map((r) => this.toDto(r));
  }

  async getById(id: string): Promise<RoadClosureDto> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Closure not found');
    }
    return this.toDto(row);
  }

  async create(userId: string, dto: CreateClosureDto): Promise<RoadClosureDto> {
    const starts = new Date(dto.starts_at);
    const ends = dto.ends_at ? new Date(dto.ends_at) : null;
    this.assertWindow(starts, ends);

    const entity = this.repo.create({
      title: dto.title,
      reason: dto.reason,
      severity: dto.severity,
      geom: this.toLineString(dto.geometry),
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
    return {
      id: r.id,
      title: r.title,
      reason: r.reason,
      severity: r.severity,
      geometry: r.geom.coordinates.map(([lng, lat]) => ({ lng, lat })),
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
    if (minLng >= maxLng || minLat >= maxLat) {
      throw new BadRequestException(
        'bbox min must be strictly less than max for both axes',
      );
    }
    return { minLng, minLat, maxLng, maxLat };
  }
}
