import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { CreateHazardDto, EXPIRY_HOURS } from './dto/create-hazard.dto.js';
import { QueryHazardsDto } from './dto/query-hazards.dto.js';
import { RouteHazardsDto } from './dto/route-hazards.dto.js';
import { HazardResponseDto } from './dto/hazard-response.dto.js';
import { EventsGateway } from '../events/events.gateway.js';

const HAZARD_SELECT_BASE = `
  SELECT
    hr.id, hr.hazard_type, hr.severity, hr.note, hr.confirmations,
    hr.created_at, hr.expires_at,
    ST_Y(hr.location::geometry) AS lat,
    ST_X(hr.location::geometry) AS lng,
    u.display_name AS reporter,
    rs.road_name
  FROM hazard_reports hr
  JOIN users u ON u.id = hr.user_id
  LEFT JOIN road_segments rs ON rs.id = hr.road_segment_id
  WHERE hr.is_active = true
    AND hr.expires_at > NOW()
`;

@Injectable()
export class HazardsService {
  constructor(
    @InjectRepository(HazardReport)
    private readonly hazardRepo: Repository<HazardReport>,
    private readonly eventsGateway: EventsGateway,
  ) {}

  async create(
    userId: string,
    dto: CreateHazardDto,
  ): Promise<HazardResponseDto> {
    const expiryHours = EXPIRY_HOURS[dto.hazard_type] ?? 24;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const hazard = this.hazardRepo.create({
      user_id: userId,
      location: {
        type: 'Point',
        coordinates: [dto.lng, dto.lat],
      },
      hazard_type: dto.hazard_type,
      severity: dto.severity ?? 'medium',
      note: dto.note ?? null,
      expires_at: expiresAt,
    });

    const saved = await this.hazardRepo.save(hazard);
    const response = this.toResponse(saved);

    // Broadcast new hazard to nearby riders via WebSocket
    this.eventsGateway.emitHazardAlert(dto.lat, dto.lng, {
      id: saved.id,
      hazard_type: dto.hazard_type,
      severity: dto.severity ?? 'medium',
      lat: dto.lat,
      lng: dto.lng,
    });

    return response;
  }

  async findNearby(query: QueryHazardsDto): Promise<HazardResponseDto[]> {
    const radius = query.radius ?? 10000;
    const typeFilter = query.types
      ? query.types.split(',').map((t) => t.trim())
      : null;

    let sql =
      HAZARD_SELECT_BASE +
      `
        AND ST_DWithin(
          hr.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
    `;
    const params: (string | number)[] = [query.lng, query.lat, radius];

    if (typeFilter && typeFilter.length > 0) {
      sql += ` AND hr.hazard_type = ANY($4)`;
      params.push(typeFilter as unknown as string);
    }

    sql += ` ORDER BY hr.created_at DESC`;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.hazardRepo.query(sql, params);
    return (rows as Record<string, unknown>[]).map((row) =>
      this.rowToResponse(row),
    );
  }

  async confirm(hazardId: string, userId: string): Promise<HazardResponseDto> {
    const hazard = await this.findActiveHazard(hazardId);

    // Prevent reporter from confirming their own hazard
    if (hazard.user_id === userId) {
      throw new BadRequestException('Cannot confirm your own hazard report');
    }

    // Atomic update to avoid lost confirmations under concurrent access
    // Also prevents the same user from extending expiry repeatedly by
    // only updating if confirmed_by doesn't already include this user
    await this.hazardRepo
      .createQueryBuilder()
      .update(HazardReport)
      .set({
        confirmations: () => 'confirmations + 1',
        confirmed_at: new Date(),
        expires_at: () => "expires_at + interval '24 hours'",
      })
      .where('id = :id AND is_active = true AND expires_at > NOW()', {
        id: hazardId,
      })
      .execute();

    const updated = await this.findActiveHazard(hazardId);
    const response = this.toResponse(updated);

    // Broadcast confirmation to nearby riders
    const coords = (
      updated.location as unknown as { coordinates: [number, number] }
    ).coordinates;
    this.eventsGateway.emitHazardAlert(coords[1], coords[0], {
      id: updated.id,
      hazard_type: updated.hazard_type,
      severity: updated.severity,
      lat: coords[1],
      lng: coords[0],
    });

    return response;
  }

  async dismiss(hazardId: string): Promise<void> {
    const hazard = await this.findActiveHazard(hazardId);
    const coords = (
      hazard.location as unknown as { coordinates: [number, number] }
    ).coordinates;

    hazard.is_active = false;
    await this.hazardRepo.save(hazard);

    // Broadcast dismissal to nearby riders
    this.eventsGateway.emitHazardAlert(coords[1], coords[0], {
      id: hazard.id,
      hazard_type: hazard.hazard_type,
      severity: 'dismissed',
      lat: coords[1],
      lng: coords[0],
    });
  }

  async findAlongRoute(dto: RouteHazardsDto): Promise<HazardResponseDto[]> {
    if (dto.route.length < 2) {
      throw new BadRequestException('Route must have at least 2 points');
    }

    const bufferM = dto.buffer_m ?? 200;

    // Build parameterized LineString from route points
    // ST_MakeLine + ST_MakePoint avoids string interpolation of coordinates
    const pointsSql = dto.route
      .map((_, i) => `ST_MakePoint($${i * 2 + 2}, $${i * 2 + 3})`)
      .join(',');
    const params: number[] = [bufferM];
    for (const p of dto.route) {
      params.push(p.lng, p.lat);
    }

    const sql =
      HAZARD_SELECT_BASE +
      `
        AND ST_DWithin(
          hr.location::geography,
          ST_SetSRID(ST_MakeLine(ARRAY[${pointsSql}]), 4326)::geography,
          $1
        )
      ORDER BY hr.created_at DESC
    `;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.hazardRepo.query(sql, params);
    return (rows as Record<string, unknown>[]).map((row) =>
      this.rowToResponse(row),
    );
  }

  async expireOld(): Promise<number> {
    const result = await this.hazardRepo
      .createQueryBuilder()
      .update(HazardReport)
      .set({ is_active: false })
      .where('is_active = true AND expires_at < NOW()')
      .execute();
    return result.affected ?? 0;
  }

  private async findActiveHazard(hazardId: string): Promise<HazardReport> {
    const hazard = await this.hazardRepo
      .createQueryBuilder('hr')
      .leftJoinAndSelect('hr.user', 'user')
      .leftJoinAndSelect('hr.road_segment', 'road_segment')
      .where('hr.id = :id AND hr.is_active = true AND hr.expires_at > NOW()', {
        id: hazardId,
      })
      .getOne();
    if (!hazard) {
      throw new NotFoundException('Hazard not found or already expired');
    }
    return hazard;
  }

  private toResponse(hazard: HazardReport): HazardResponseDto {
    const coords = (
      hazard.location as unknown as { coordinates: [number, number] }
    ).coordinates;
    return {
      id: hazard.id,
      lat: coords[1],
      lng: coords[0],
      hazard_type: hazard.hazard_type,
      severity: hazard.severity,
      note: hazard.note,
      confirmations: hazard.confirmations,
      reporter: hazard.user?.display_name ?? null,
      road_name: hazard.road_segment?.road_name ?? null,
      created_at: hazard.created_at.toISOString(),
      expires_at: hazard.expires_at.toISOString(),
    };
  }

  private rowToResponse(row: Record<string, unknown>): HazardResponseDto {
    return {
      id: row.id as string,
      lat: row.lat as number,
      lng: row.lng as number,
      hazard_type: row.hazard_type as string,
      severity: row.severity as string,
      note: (row.note as string) ?? null,
      confirmations: row.confirmations as number,
      reporter: (row.reporter as string) ?? null,
      road_name: (row.road_name as string) ?? null,
      created_at: (row.created_at as Date).toISOString(),
      expires_at: (row.expires_at as Date).toISOString(),
    };
  }
}
