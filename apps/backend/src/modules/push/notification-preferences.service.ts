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
    return mergeWithDefaults(row) as NotificationPreferencesResponseDto;
  }

  async update(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponseDto> {
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
    return mergeWithDefaults(saved) as NotificationPreferencesResponseDto;
  }
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
      if (override) {
        next.categories[cat] = {
          email: !!override.email,
          push: !!override.push,
          in_app: override.in_app !== false,
        };
      }
    }
  }
  return next;
}
