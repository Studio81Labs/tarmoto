import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationPreferences,
} from '@tarmoto/shared';
import { NotificationPreferencesRow } from '../../entities/notification-preferences.entity.js';
import { mergeWithDefaults } from './push.service.js';
import {
  NotificationPreferencesResponseDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification-preferences.dto.js';

/**
 * Reads and writes per-user notification preferences.
 *
 * Reads always return the full preference shape, falling back to the
 * canonical defaults from `@tarmoto/shared` when no row exists. The
 * mobile + companion clients can render the preferences UI without
 * caring whether the user has saved anything before.
 *
 * Writes are partial — only supplied fields update; categories not
 * mentioned keep their existing toggles. This matches how the
 * companion's preference page sends granular updates.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    @InjectRepository(NotificationPreferencesRow)
    private readonly repo: Repository<NotificationPreferencesRow>,
  ) {}

  async get(userId: string): Promise<NotificationPreferencesResponseDto> {
    const row = await this.repo.findOne({ where: { user_id: userId } });
    return mergeWithDefaults(row);
  }

  async update(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponseDto> {
    // A timezone-only patch — the mobile / companion background timezone sync —
    // is written atomically (upsert of just that column) so it can't clobber a
    // concurrent full save. The read-modify-write path below overwrites EVERY
    // column, so if a tz-only request read the row before another client's
    // settings save but committed after it, it would restore the pre-save
    // email_digest / categories while the UI reported success. A user-facing
    // save always carries other fields, so it takes the full path.
    if (isTimezoneOnlyPatch(dto)) {
      await this.setTimezone(userId, dto.quiet_hours_timezone || 'UTC');
      return this.get(userId);
    }

    const existing = await this.repo.findOne({ where: { user_id: userId } });

    // Merge against current persisted state (or defaults) so the
    // returned shape is always the full preferences object.
    const current = mergeWithDefaults(existing);
    const merged = applyPatch(current, dto);

    const row =
      existing ??
      this.repo.create({
        user_id: userId,
        categories: {},
      });

    row.email_digest = merged.email_digest;
    row.marketing_emails = merged.marketing_emails;
    row.quiet_hours_start = merged.quiet_hours_start;
    row.quiet_hours_end = merged.quiet_hours_end;
    row.quiet_hours_timezone = merged.quiet_hours_timezone || 'UTC';
    row.categories = merged.categories;

    const saved = await this.repo.save(row);
    return mergeWithDefaults(saved);
  }

  /**
   * Atomic upsert of only `quiet_hours_timezone`. ON CONFLICT touches that one
   * column (and updated_at), leaving email_digest / categories / quiet-hours
   * windows intact — so a background timezone sync from one client can't undo a
   * concurrent preferences save from another. Omitted columns take their table
   * defaults on insert (all NOT NULL DEFAULT ...).
   */
  private async setTimezone(userId: string, timezone: string): Promise<void> {
    await this.repo.query(
      `INSERT INTO notification_preferences (user_id, quiet_hours_timezone)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET quiet_hours_timezone = EXCLUDED.quiet_hours_timezone,
             updated_at = now()`,
      [userId, timezone],
    );
  }
}

/**
 * True when the patch sets only `quiet_hours_timezone` — the background sync
 * shape — so `update` can route it to the atomic single-column write instead of
 * a full read-modify-write.
 */
function isTimezoneOnlyPatch(dto: UpdateNotificationPreferencesDto): boolean {
  return (
    dto.quiet_hours_timezone !== undefined &&
    dto.email_digest === undefined &&
    dto.marketing_emails === undefined &&
    dto.quiet_hours_start === undefined &&
    dto.quiet_hours_end === undefined &&
    dto.categories === undefined
  );
}

function applyPatch(
  current: NotificationPreferences,
  patch: UpdateNotificationPreferencesDto,
): NotificationPreferences {
  const next: NotificationPreferences = {
    ...current,
    categories: { ...current.categories },
  };
  if (patch.email_digest !== undefined) next.email_digest = patch.email_digest;
  if (patch.marketing_emails !== undefined) {
    next.marketing_emails = patch.marketing_emails;
  }
  if (patch.quiet_hours_start !== undefined) {
    next.quiet_hours_start = patch.quiet_hours_start;
  }
  if (patch.quiet_hours_end !== undefined) {
    next.quiet_hours_end = patch.quiet_hours_end;
  }
  if (patch.quiet_hours_timezone !== undefined) {
    next.quiet_hours_timezone = patch.quiet_hours_timezone;
  }
  if (patch.categories) {
    for (const cat of NOTIFICATION_CATEGORIES) {
      const override = patch.categories[cat];
      if (!override) continue;
      // Per-field merge with the existing toggles. Overwrite only the
      // fields the patch explicitly supplies; coerce supplied values
      // to a strict boolean. Earlier we used `!!email && !!push`
      // alongside `in_app !== false` which (a) silently defaulted
      // `in_app` to `true` when missing — drifting from "supplied
      // fields only" — and (b) treated `0`/`""` differently per
      // field, an asymmetric coercion that would surprise anyone
      // posting from a hand-rolled client without class-transformer
      // normalisation in the path.
      const existing = next.categories[cat];
      next.categories[cat] = {
        email:
          override.email !== undefined
            ? Boolean(override.email)
            : existing.email,
        push:
          override.push !== undefined ? Boolean(override.push) : existing.push,
        in_app:
          override.in_app !== undefined
            ? Boolean(override.in_app)
            : existing.in_app,
      };
    }
  }
  return next;
}
