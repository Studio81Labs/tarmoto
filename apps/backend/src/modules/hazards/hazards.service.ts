import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HazardType, HazardSeverity } from '@tarmoto/shared';
import { hasControlCharacters } from '../../common/control-characters.js';
import { LOOPBACK_HOSTS } from '../../common/loopback-hosts.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { CreateHazardDto, EXPIRY_HOURS } from './dto/create-hazard.dto.js';
import { QueryHazardsDto } from './dto/query-hazards.dto.js';
import { RouteHazardsDto } from './dto/route-hazards.dto.js';
import { HazardResponseDto } from './dto/hazard-response.dto.js';
import {
  ALLOWED_HAZARD_PHOTO_TYPES,
  HAZARD_PHOTO_PATH_PREFIX,
  HazardPhotoUploadResponseDto,
  sanitizeHazardPhotoUrl,
} from './dto/hazard-photo.dto.js';
import { EventsGateway } from '../events/events.gateway.js';
import { PushService } from '../push/index.js';

const HAZARD_PHOTO_UPLOAD_DIR = join(process.cwd(), 'uploads', 'hazard-photos');

/**
 * Decide whether a `<scheme>://<host>` origin belongs to *our* hazard
 * upload storage. Mirrors the review-photo helper: a third-party URL
 * that happens to share the `/uploads/hazard-photos/` pathname must
 * never be misclassified as managed, otherwise a delete-on-update
 * cascade could `unlink` an unrelated file in our managed directory
 * just because the path matched. Treat as managed iff the origin
 * matches `TARMOTO_PUBLIC_BASE_URL` OR (outside production) the host
 * is loopback — same trust posture the upload endpoint uses when it
 * builds outgoing URLs.
 */
function buildTrustedManagedOriginCheck(
  config: ConfigService,
): (parsed: URL) => boolean {
  const configured = config.get<string>('TARMOTO_PUBLIC_BASE_URL')?.trim();
  let configuredOrigin: string | null = null;
  if (configured && configured.length > 0) {
    try {
      configuredOrigin = new URL(configured).origin;
    } catch {
      // Bad config falls through; the upload endpoint's own probe will
      // surface the 500 with a clearer error.
    }
  }
  return (parsed: URL): boolean => {
    if (configuredOrigin && parsed.origin === configuredOrigin) return true;
    if (
      process.env.TARMOTO_NODE_ENV !== 'production' &&
      LOOPBACK_HOSTS.has(parsed.hostname)
    ) {
      return true;
    }
    return false;
  };
}

interface ManagedHazardPhoto {
  filename: string;
  filePath: string;
}

/**
 * Resolve a hazard photo URL to its managed filename + on-disk path,
 * or `null` when the URL is not one we own. Same defense-in-depth as
 * the review-photo resolver: only honour the URL when the origin is
 * trusted AND the pathname carries the managed prefix, and reject
 * decoded filenames with path separators, control chars, or `.`/`..`
 * segments so a crafted `photo_url` can't make a delete escape the
 * managed directory.
 */
function resolveManagedHazardPhoto(
  photoUrl: string | null,
  isTrustedOrigin: (parsed: URL) => boolean,
): ManagedHazardPhoto | null {
  if (!photoUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(photoUrl);
  } catch {
    return null;
  }

  if (!isTrustedOrigin(parsed)) return null;
  if (!parsed.pathname.startsWith(HAZARD_PHOTO_PATH_PREFIX)) return null;

  const encodedFilename = parsed.pathname.slice(
    HAZARD_PHOTO_PATH_PREFIX.length,
  );
  if (!encodedFilename) return null;

  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return null;
  }
  if (
    filename === '.' ||
    filename === '..' ||
    filename !== basename(filename) ||
    filename.includes('/') ||
    filename.includes('\\') ||
    hasControlCharacters(filename)
  ) {
    return null;
  }

  return { filename, filePath: join(HAZARD_PHOTO_UPLOAD_DIR, filename) };
}

function buildOwnedPrefix(userId: string): string {
  return `${userId}-`;
}

function isOwnedManagedPhoto(
  photo: ManagedHazardPhoto,
  userId: string,
): boolean {
  return photo.filename.startsWith(buildOwnedPrefix(userId));
}

/**
 * Reject a `photo_url` payload that references a managed file the
 * caller doesn't own. Mirrors the review-photo guard: without it user
 * B could attach user A's `/uploads/hazard-photos/...` URL to B's own
 * report, and a later dismiss would unlink the shared file out from
 * under A. Forcing every managed URL to carry the caller's `<userId>-`
 * filename prefix means cascade deletes only ever touch files the
 * same user produced.
 */
function assertHazardPhotoIsOwned(
  photoUrl: string | null | undefined,
  userId: string,
  isTrustedOrigin: (parsed: URL) => boolean,
): void {
  if (!photoUrl) return;
  const managed = resolveManagedHazardPhoto(photoUrl, isTrustedOrigin);
  if (!managed) return;
  if (!isOwnedManagedPhoto(managed, userId)) {
    throw new BadRequestException(
      'Photo URL refers to a file you did not upload',
    );
  }
}

/**
 * Best-effort delete of a managed hazard-photo file the caller owns.
 * Third-party URLs, missing files, and managed files uploaded by
 * another user are skipped silently — the row is already gone, and a
 * stray orphan shouldn't surface a 500. Permission errors still
 * bubble so an operator notices a misconfigured uploads directory.
 */
async function deleteOwnedHazardPhoto(
  photoUrl: string | null | undefined,
  userId: string,
  isTrustedOrigin: (parsed: URL) => boolean,
): Promise<void> {
  if (!photoUrl) return;
  const managed = resolveManagedHazardPhoto(photoUrl, isTrustedOrigin);
  if (!managed) return;
  if (!isOwnedManagedPhoto(managed, userId)) return;
  try {
    await unlink(managed.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Buffer in metres around a saved commute route — riders within this
 * buffer of a fresh hazard get a background push. 200m matches the
 * default `bufferM` used by the route-hazards REST query so the two
 * surfaces agree on what counts as "on this route".
 */
const COMMUTE_HAZARD_BUFFER_M = 200;

const HAZARD_SELECT_BASE = `
  SELECT
    hr.id, hr.hazard_type, hr.severity, hr.note, hr.photo_url, hr.confirmations,
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
  private readonly logger = new Logger(HazardsService.name);
  // Built once at construction so each create / dismiss doesn't re-read
  // TARMOTO_PUBLIC_BASE_URL. Closes the loophole where a third-party URL
  // with our managed pathname prefix would be misclassified as managed
  // (see `buildTrustedManagedOriginCheck`).
  private readonly isTrustedManagedOrigin: (parsed: URL) => boolean;

  constructor(
    @InjectRepository(HazardReport)
    private readonly hazardRepo: Repository<HazardReport>,
    @InjectRepository(CommuteRoute)
    private readonly commuteRepo: Repository<CommuteRoute>,
    private readonly eventsGateway: EventsGateway,
    private readonly pushService: PushService,
    config: ConfigService,
  ) {
    this.isTrustedManagedOrigin = buildTrustedManagedOriginCheck(config);
  }

  async create(
    userId: string,
    dto: CreateHazardDto,
  ): Promise<HazardResponseDto> {
    const expiryHours = EXPIRY_HOURS[dto.hazard_type] ?? 24;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const photoUrl = dto.photo_url?.trim();
    if (photoUrl) {
      // Block attaching a managed photo someone else uploaded — DTO-level
      // URL validation only checks shape, not authorization.
      assertHazardPhotoIsOwned(photoUrl, userId, this.isTrustedManagedOrigin);
    }

    const hazard = this.hazardRepo.create({
      user_id: userId,
      location: {
        type: 'Point',
        coordinates: [dto.lng, dto.lat],
      },
      hazard_type: dto.hazard_type,
      severity: dto.severity ?? 'medium',
      note: dto.note ?? null,
      photo_url: photoUrl ? photoUrl : null,
      expires_at: expiresAt,
    });

    const saved = await this.hazardRepo.save(hazard);
    // Reload with user + road_segment joined so the response (and the
    // WebSocket broadcast below) carry the reporter's display name and the
    // road name. `save` doesn't hydrate relations, so without this step
    // every freshly-broadcast hazard would show up on other clients as an
    // anonymous report until the next REST refresh filled it in.
    const hydrated = await this.findActiveHazard(saved.id);
    const response = this.toResponse(hydrated);

    // Broadcast new hazard to nearby riders via WebSocket
    this.emitHazardEvent(response);

    // Background push to riders whose saved commute passes near this
    // hazard. Excludes the reporter — they don't need a push for
    // their own report.
    void this.notifyRidersOnSavedCommute(response, userId);

    return response;
  }

  private async notifyRidersOnSavedCommute(
    hazard: HazardResponseDto,
    reporterId: string,
  ): Promise<void> {
    try {
      // Single SQL pass: find every commute route that passes within
      // COMMUTE_HAZARD_BUFFER_M of the hazard, return distinct user_ids.
      // PostGIS `ST_DWithin` on the geography cast handles the metric
      // distance correctly across the EPSG:4326 source.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const rows = await this.commuteRepo.query(
        `
          SELECT DISTINCT cr.user_id
          FROM commute_routes cr
          WHERE cr.route_geom IS NOT NULL
            AND cr.user_id != $1
            AND ST_DWithin(
              cr.route_geom::geography,
              ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
              $4
            )
        `,
        [reporterId, hazard.lng, hazard.lat, COMMUTE_HAZARD_BUFFER_M],
      );

      const recipients = (rows as { user_id: string }[]).map((r) => r.user_id);
      if (recipients.length === 0) return;

      const where = hazard.road_name ? ` on ${hazard.road_name}` : '';
      await this.pushService.sendToUsers(recipients, {
        category: 'hazard_alert',
        title: 'Hazard ahead on your commute',
        body: `${humanizeHazardType(hazard.hazard_type)} reported${where}`,
        data: {
          type: 'hazard_alert',
          hazard_id: hazard.id,
          hazard_type: hazard.hazard_type,
          lat: String(hazard.lat),
          lng: String(hazard.lng),
        },
      });
    } catch (err) {
      this.logger.warn(
        `hazard_alert push failed (hazard=${hazard.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
    this.emitHazardEvent(response);

    return response;
  }

  async dismiss(hazardId: string): Promise<void> {
    const hazard = await this.findActiveHazard(hazardId);
    const response = this.toResponse(hazard);

    hazard.is_active = false;
    await this.hazardRepo.save(hazard);

    // Cascade-delete the managed photo file so a dismissed hazard
    // doesn't keep its attachment around — an orphan would never be
    // referenced again but would still bill storage. Run after save
    // so a DB failure can't leave the row pointing at a file we
    // already unlinked. The ownership filter inside
    // `deleteOwnedHazardPhoto` ensures we never delete a file
    // another user uploaded.
    await deleteOwnedHazardPhoto(
      hazard.photo_url,
      hazard.user_id,
      this.isTrustedManagedOrigin,
    );

    // Broadcast dismissal to nearby riders. The wire-level event uses
    // a looser `severity: string` so we can repurpose the field as a
    // `dismissed` signal — clients use this to prune the hazard from
    // the local map without a follow-up REST poll. The DTO's narrow
    // `HazardSeverity` enum can't carry it, so we cast at the boundary.
    this.eventsGateway.emitHazardAlert(response.lat, response.lng, {
      ...response,
      severity: 'dismissed',
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
      hazard_type: hazard.hazard_type as HazardType,
      severity: hazard.severity as HazardSeverity,
      note: hazard.note,
      photo_url: sanitizeHazardPhotoUrl(hazard.photo_url),
      confirmations: hazard.confirmations,
      reporter: hazard.user?.display_name ?? null,
      road_name: hazard.road_segment?.road_name ?? null,
      created_at: hazard.created_at.toISOString(),
      expires_at: hazard.expires_at.toISOString(),
    };
  }

  private emitHazardEvent(response: HazardResponseDto): void {
    this.eventsGateway.emitHazardAlert(response.lat, response.lng, response);
  }

  private rowToResponse(row: Record<string, unknown>): HazardResponseDto {
    return {
      id: row.id as string,
      lat: row.lat as number,
      lng: row.lng as number,
      hazard_type: row.hazard_type as HazardType,
      severity: row.severity as HazardSeverity,
      note: (row.note as string) ?? null,
      photo_url: sanitizeHazardPhotoUrl(row.photo_url),
      confirmations: row.confirmations as number,
      reporter: (row.reporter as string) ?? null,
      road_name: (row.road_name as string) ?? null,
      created_at: (row.created_at as Date).toISOString(),
      expires_at: (row.expires_at as Date).toISOString(),
    };
  }

  /**
   * Persist an uploaded hazard photo to local disk and return the URL
   * the caller should submit on the next `POST /hazards`.
   *
   * The endpoint deliberately doesn't require a hazard to exist yet —
   * the typical flow is upload-then-create, and forcing an upfront
   * round-trip would just slow the rider's tap on a marginal cell
   * connection. Orphaned files (uploaded then never attached) are
   * accepted as a known cost; an S3-backed lifecycle sweep is tracked
   * separately. Filenames are scoped to the uploading user so a later
   * dismiss / cleanup cascade can't touch another rider's photo.
   */
  async uploadPhoto(
    userId: string,
    file: Express.Multer.File,
    publicBaseUrl: string,
  ): Promise<HazardPhotoUploadResponseDto> {
    const extension = ALLOWED_HAZARD_PHOTO_TYPES.get(file.mimetype);
    if (!extension) {
      throw new BadRequestException('Photos must be PNG, JPEG, or WebP images');
    }

    await mkdir(HAZARD_PHOTO_UPLOAD_DIR, { recursive: true });

    const filename = `${userId}-${Date.now()}-${randomUUID()}${extension}`;
    const filePath = join(HAZARD_PHOTO_UPLOAD_DIR, filename);
    try {
      await writeFile(filePath, file.buffer);
    } catch (error) {
      // Best-effort cleanup so a partial write doesn't leak storage
      // when the disk fills mid-upload (ENOSPC) or a permission flip
      // creates a zero-byte file we never finished. unlink failure
      // here is fine — there's nothing to leak when there was nothing
      // to write.
      await unlink(filePath).catch(() => {});
      throw error;
    }

    return {
      photo_url: `${publicBaseUrl}${HAZARD_PHOTO_PATH_PREFIX}${filename}`,
    };
  }
}

function humanizeHazardType(hazardType: string): string {
  switch (hazardType) {
    case 'pothole':
      return 'Pothole';
    case 'gravel':
      return 'Loose gravel';
    case 'oil_spill':
      return 'Oil spill';
    case 'roadworks':
      return 'Roadworks';
    case 'animals':
      return 'Animals on road';
    case 'police':
      return 'Police checkpoint';
    case 'flooding':
      return 'Flooding';
    case 'ice':
      return 'Ice / black ice';
    default:
      return 'Hazard';
  }
}
