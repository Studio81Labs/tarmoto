import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HazardType, HazardSeverity } from '@tarmoto/shared';
import {
  resolveManagedPhoto,
  type ManagedPhoto,
} from '../../common/managed-photo-url.js';
import { buildTrustedManagedOriginCheck } from '../../common/trusted-managed-origin.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
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
import {
  EventsGateway,
  type HazardAlertPayload,
} from '../events/events.gateway.js';
import { PushService } from '../push/index.js';
import { FEATURE_LIMIT_EXCEEDED, isWithinLimit } from '@tarmoto/shared';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { featureLimitExceeded } from '../features/feature-limit.error.js';

const HAZARD_PHOTO_UPLOAD_DIR = join(process.cwd(), 'uploads', 'hazard-photos');

/**
 * Resolve a hazard photo URL to its managed filename + on-disk path,
 * or `null` when the URL is not one we own. Thin wrapper around the
 * shared `resolveManagedPhoto` so the path-traversal guard stays
 * single-sourced — see that helper's comment for the full
 * separator/control-char/dot-segment rationale.
 */
function resolveManagedHazardPhoto(
  photoUrl: string | null,
  isTrustedOrigin: (parsed: URL) => boolean,
): ManagedPhoto | null {
  return resolveManagedPhoto(photoUrl, {
    pathPrefix: HAZARD_PHOTO_PATH_PREFIX,
    uploadDir: HAZARD_PHOTO_UPLOAD_DIR,
    isTrustedOrigin,
  });
}

function buildOwnedPrefix(userId: string): string {
  return `${userId}-`;
}

function isOwnedManagedPhoto(photo: ManagedPhoto, userId: string): boolean {
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
 * True only for the specific `hazard_reports_per_day` cap rejection thrown by
 * `assertWithinDailyReportCap`. Used to scope the orphaned-photo cleanup: a
 * transient failure in the limit lookup / count query must NOT delete the
 * caller's upload (the report still has a valid `photo_url` on retry, and
 * other clients could permanently lose the attachment).
 */
function isHazardDailyCapRejection(error: unknown): boolean {
  if (!(error instanceof ForbiddenException)) return false;
  const response = error.getResponse();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: unknown }).code === FEATURE_LIMIT_EXCEEDED &&
    (response as { feature?: unknown }).feature === 'hazard_reports_per_day'
  );
}

/**
 * Buffer in metres around a saved commute route — riders within this
 * buffer of a fresh hazard get a background push. 200m matches the
 * default `bufferM` used by the route-hazards REST query so the two
 * surfaces agree on what counts as "on this route".
 */
const COMMUTE_HAZARD_BUFFER_M = 200;

// #279 / #501 — `reporter` is masked to NULL when the rider's
// `profile_visibility` is `'private'`. Hazard reports are a public-by-
// default surface (the map shows everyone's reports), so the rider's
// explicit "do not show me anywhere" toggle has to suppress the
// display name even though the geometry stays visible. The LEFT JOIN
// is left-side so riders without an explicit privacy_preferences row
// (defaults apply, not private) still surface their name.
//
// `is_private_reporter` is surfaced separately so the row mapper can
// also null `photo_url` for private reporters (Codex review on PR
// #513 r3212896110): managed hazard photos are stored under
// `/uploads/hazard-photos/<userId>-<ts>-...`, so returning the URL
// while masking the name still leaks the rider's UUID via the
// filename. Suppressing the URL on the public response is the
// targeted fix; the file itself stays on disk so the rider's own
// review of their report (a future feature) can still surface it.
export const HAZARD_SELECT_BASE = `
  SELECT
    hr.id, hr.hazard_type, hr.severity, hr.note, hr.photo_url, hr.confirmations,
    hr.created_at, hr.expires_at,
    ST_Y(hr.location::geometry) AS lat,
    ST_X(hr.location::geometry) AS lng,
    CASE WHEN pp.profile_visibility = 'private' THEN NULL ELSE u.display_name END AS reporter,
    (pp.profile_visibility = 'private') AS is_private_reporter,
    rs.road_name
  FROM hazard_reports hr
  JOIN users u ON u.id = hr.user_id
  LEFT JOIN privacy_preferences pp ON pp.user_id = hr.user_id
  LEFT JOIN road_segments rs ON rs.id = hr.road_segment_id
  WHERE hr.is_active = true
    AND hr.expires_at > NOW()
    AND hr.moderation_status = 'visible'
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
    private readonly privacy: PrivacyPreferencesService,
    private readonly featureResolver: FeatureResolver,
    config: ConfigService,
  ) {
    this.isTrustedManagedOrigin = buildTrustedManagedOriginCheck(config);
  }

  /**
   * Anti-abuse `hazard_reports_per_day` cap — a rate limit, not a pricing
   * lever (all tiers share the same value; `0` doubles as an operator kill
   * switch for reporting). Counts the caller's reports over a rolling 24h
   * window (expired reports are DEACTIVATED, not deleted, so the count stays
   * accurate) and rejects at/over the cap with the same
   * `FEATURE_LIMIT_EXCEEDED` contract the trip caps use. A `null` limit is
   * unlimited and skips the count. Not advisory-locked: a tiny race (allowing
   * 51 rather than 50 under simultaneous submits) is acceptable for a
   * best-effort abuse cap, matching `assertCanMintOpenTrip`.
   */
  private async assertWithinDailyReportCap(userId: string): Promise<void> {
    const limits = await this.featureResolver.resolveLimitsForUser(userId);
    const limit = limits.hazard_reports_per_day;
    if (limit === null) return;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const current = await this.hazardRepo.count({
      where: { user_id: userId, created_at: MoreThanOrEqual(since) },
    });
    if (!isWithinLimit(limit, current)) {
      throw featureLimitExceeded('hazard_reports_per_day', limit, current);
    }
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
      // URL validation only checks shape, not authorization. Runs BEFORE the
      // cap check so a non-owned attach is still rejected and the cleanup
      // below never touches another rider's file.
      assertHazardPhotoIsOwned(photoUrl, userId, this.isTrustedManagedOrigin);
    }

    // The photo is uploaded by a separate `POST /hazards/photos` call BEFORE
    // this create, so a cap rejection here would strand that file (the backend
    // has no orphan sweeper — cleanup is driven by dismiss/delete of a real
    // row). Delete the caller's own managed upload before re-throwing so a
    // capped rider retrying the still-open form can't steadily leak storage.
    // Scope cleanup to the actual cap rejection: a transient DB failure in the
    // limit lookup / count must re-throw WITHOUT deleting a photo the retry
    // (or another client) still references.
    try {
      await this.assertWithinDailyReportCap(userId);
    } catch (error) {
      if (isHazardDailyCapRejection(error)) {
        await deleteOwnedHazardPhoto(
          photoUrl,
          userId,
          this.isTrustedManagedOrigin,
        );
      }
      throw error;
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
    // #279 / #501 — mirror the `HAZARD_SELECT_BASE` reporter mask on
    // the relation-based path. The reporter is the caller themselves
    // here, so the privacy lookup is for their own row; we still mask
    // before broadcast so other clients (which receive the same DTO
    // via WebSocket) never see a private rider's name.
    const reporterIsPrivate = await this.isReporterPrivate(userId);
    const response = this.toResponse(hydrated, { reporterIsPrivate });

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
    const reporterIsPrivate = await this.isReporterPrivate(updated.user_id);
    const response = this.toResponse(updated, { reporterIsPrivate });

    // Broadcast confirmation to nearby riders
    this.emitHazardEvent(response);

    return response;
  }

  async dismiss(hazardId: string): Promise<void> {
    const hazard = await this.findActiveHazard(hazardId);
    const reporterIsPrivate = await this.isReporterPrivate(hazard.user_id);
    const response = this.toResponse(hazard, { reporterIsPrivate });

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

  /**
   * Admin hard-delete: load → delete row → only if delete succeeded, purge
   * managed photo + broadcast dismissal.
   *
   * The ordering guarantee is: if `hazardRepo.delete` throws, neither the
   * photo file nor WebSocket clients are touched — the DB row survives and
   * can be retried. This mirrors the `dismiss()` cleanup order (which runs
   * after `save`) but uses a hard `DELETE` instead of a soft
   * `is_active = false` so the row is gone entirely.
   *
   * Returns `true` when the row was deleted, `false` when no row was found.
   */
  async adminHardDelete(id: string): Promise<boolean> {
    const hazard = await this.hazardRepo.findOne({
      where: { id },
      relations: ['user', 'road_segment'],
    });
    if (!hazard) return false;
    const reporterIsPrivate = await this.isReporterPrivate(hazard.user_id);
    const response = this.toResponse(hazard, { reporterIsPrivate });
    await this.hazardRepo.delete({ id });
    // Delete succeeded — the row is gone from public REST. Broadcast the
    // removal FIRST so connected maps prune the marker even if the photo
    // cleanup below then fails (e.g. an uploads-dir permission error):
    // a storage error must not leave a stale marker on every client.
    this.eventsGateway.emitHazardAlert(
      response.lat,
      response.lng,
      this.toRemovalTombstone(response),
    );
    // Best-effort managed-photo cleanup; a failure here surfaces to the
    // operator but no longer suppresses the removal broadcast above.
    await deleteOwnedHazardPhoto(
      hazard.photo_url,
      hazard.user_id,
      this.isTrustedManagedOrigin,
    );
    return true;
  }

  /**
   * Broadcast a removal signal for any hazard the admin has hidden or
   * hard-deleted so that connected map clients prune the marker
   * immediately — without waiting for a REST refetch. Loads the row
   * directly by id (no active/visible filter) because the row may
   * already be hidden when this is called. No-op when the id is not
   * found (e.g. a concurrent delete race).
   */
  async broadcastRemoval(hazardId: string): Promise<void> {
    const hazard = await this.hazardRepo.findOne({
      where: { id: hazardId },
      relations: ['user', 'road_segment'],
    });
    if (!hazard) return;
    const reporterIsPrivate = await this.isReporterPrivate(hazard.user_id);
    const response = this.toResponse(hazard, { reporterIsPrivate });
    this.eventsGateway.emitHazardAlert(
      response.lat,
      response.lng,
      this.toRemovalTombstone(response),
    );
  }

  /**
   * Build a redacted removal payload for an admin moderation action.
   * Admin hide/delete targets abusive content, and the dismissed event
   * fans out to every subscriber in the cell over the unauthenticated
   * `subscribe:hazards` channel — so it must NOT echo the note /
   * photo_url / reporter we are taking down. Clients key the removal off
   * `id` (+ `severity: 'dismissed'`); `lat`/`lng` only route the event to
   * the cell room. Every other field is nulled/zeroed. (The user-facing
   * `dismiss()` keeps the full payload — that's the reporter removing
   * their own content, not moderation of someone else's.)
   */
  private toRemovalTombstone(response: HazardResponseDto): HazardAlertPayload {
    return {
      id: response.id,
      lat: response.lat,
      lng: response.lng,
      severity: 'dismissed',
      hazard_type: '',
      note: null,
      confirmations: 0,
      reporter: null,
      road_name: null,
      created_at: '',
      expires_at: '',
    };
  }

  /**
   * Broadcast a normal `hazard:new` event (not dismissed) for a hazard that
   * has just been admin-restored to visible. Only emits when the hazard is
   * active, visible, and not yet expired — a restore on an already-expired or
   * inactive row should not re-add a stale marker to live maps.
   *
   * No-op when the id is not found (e.g. concurrent delete race).
   */
  async broadcastRestore(hazardId: string): Promise<void> {
    const hazard = await this.hazardRepo.findOne({
      where: { id: hazardId },
      relations: ['user', 'road_segment'],
    });
    if (!hazard) return;
    if (
      !hazard.is_active ||
      hazard.moderation_status !== 'visible' ||
      hazard.expires_at.getTime() <= Date.now()
    ) {
      return;
    }
    const reporterIsPrivate = await this.isReporterPrivate(hazard.user_id);
    const response = this.toResponse(hazard, { reporterIsPrivate });
    this.emitHazardEvent(response);
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
      .where(
        "hr.id = :id AND hr.is_active = true AND hr.expires_at > NOW() AND hr.moderation_status = 'visible'",
        { id: hazardId },
      )
      .getOne();
    if (!hazard) {
      throw new NotFoundException('Hazard not found or already expired');
    }
    return hazard;
  }

  private toResponse(
    hazard: HazardReport,
    opts: { reporterIsPrivate?: boolean } = {},
  ): HazardResponseDto {
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
      // #279 / #501 — managed hazard photos embed the rider's id in
      // their filename (`<userId>-<ts>-...`), so emitting the URL on
      // a private reporter's report would leak the same id this path
      // is masking. Suppress the URL alongside the name (Codex
      // review on PR #513 r3212896110).
      photo_url: opts.reporterIsPrivate
        ? null
        : sanitizeHazardPhotoUrl(hazard.photo_url),
      confirmations: hazard.confirmations,
      // #279 / #501 — opted-out reporters surface as `null` so the
      // map UI renders an "Anonymous reporter" tag instead of leaking
      // the rider's name to anyone with a hazard ping.
      reporter: opts.reporterIsPrivate
        ? null
        : (hazard.user?.display_name ?? null),
      road_name: hazard.road_segment?.road_name ?? null,
      created_at: hazard.created_at.toISOString(),
      expires_at: hazard.expires_at.toISOString(),
    };
  }

  /**
   * Lookup helper for the relation-based load paths (`create`,
   * `confirm`, `dismiss`) which use TypeORM relations to hydrate the
   * `user` and `road_segment` fields and therefore can't reuse the
   * masked SQL projection in `HAZARD_SELECT_BASE`. Defaults
   * fail-closed: if the privacy fetch errors we treat the rider as
   * private rather than leaking the name on a transient DB hiccup.
   */
  private async isReporterPrivate(userId: string): Promise<boolean> {
    try {
      const prefs = await this.privacy.loadPreferences(userId);
      return prefs.profile_visibility === 'private';
    } catch {
      return true;
    }
  }

  private emitHazardEvent(response: HazardResponseDto): void {
    this.eventsGateway.emitHazardAlert(response.lat, response.lng, response);
  }

  private rowToResponse(row: Record<string, unknown>): HazardResponseDto {
    // #279 / #501 — managed hazard photos are stored under
    // `/uploads/hazard-photos/<userId>-<ts>-...`, so emitting the URL
    // for a private reporter would leak the rider's UUID through the
    // filename even after the SQL CASE blanks `reporter`. Suppress
    // the URL on the public response (Codex review on PR #513
    // r3212896110). Third-party / non-managed URLs would also be
    // suppressed — the rider's privacy preference covers any media
    // they attached, regardless of where it lives.
    const reporterIsPrivate = row.is_private_reporter === true;
    return {
      id: row.id as string,
      lat: row.lat as number,
      lng: row.lng as number,
      hazard_type: row.hazard_type as HazardType,
      severity: row.severity as HazardSeverity,
      note: (row.note as string) ?? null,
      photo_url: reporterIsPrivate
        ? null
        : sanitizeHazardPhotoUrl(row.photo_url),
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
