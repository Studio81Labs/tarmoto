import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  CRITICAL_NOTIFICATION_CATEGORIES,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationCategory,
  type NotificationChannelToggles,
  type NotificationPreferences,
} from '@tarmoto/shared';
import { DeviceToken } from '../../entities/device-token.entity.js';
import { NotificationPreferencesRow } from '../../entities/notification-preferences.entity.js';
import { UserNotification } from '../../entities/user-notification.entity.js';
import { LogPushProvider } from './providers/log.provider.js';
import {
  PUSH_PROVIDER,
  type PushPayload,
  type PushProvider,
  type PushTarget,
} from './push-provider.js';

export interface PushNotificationInput {
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushDispatchResult {
  /** Tokens the provider accepted. */
  delivered: number;
  /** Tokens marked invalid and soft-deleted. */
  pruned: number;
  /** True when preferences gated the dispatch entirely (no provider call). */
  suppressed: boolean;
  /** Reason for suppression — only set when `suppressed` is true. */
  suppressedReason?: 'preference-off' | 'quiet-hours' | 'no-tokens';
}

/**
 * Public surface for everywhere in the backend that needs to push.
 *
 * Responsibilities, in order:
 *   1. Load the user's preferences (lazy default if no row exists).
 *   2. Gate by category-channel toggle and quiet hours (critical
 *      categories bypass quiet hours).
 *   3. Load active device tokens for the user.
 *   4. Hand off to the configured `PushProvider` — the service does
 *      not know FCM from APN.
 *   5. Soft-delete tokens the provider reported as terminally dead.
 *
 * Sends are best-effort. Callers MUST NOT propagate failures into
 * user-facing API responses (a follow shouldn't 500 because FCM is
 * having a bad afternoon).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly fallback: PushProvider;

  constructor(
    @InjectRepository(DeviceToken)
    private readonly tokenRepo: Repository<DeviceToken>,
    @InjectRepository(NotificationPreferencesRow)
    private readonly prefsRepo: Repository<NotificationPreferencesRow>,
    @InjectRepository(UserNotification)
    private readonly notificationRepo: Repository<UserNotification>,
    @Inject(PUSH_PROVIDER)
    @Optional()
    private readonly provider: PushProvider | null,
  ) {
    this.fallback = new LogPushProvider();
  }

  async sendToUser(
    userId: string,
    input: PushNotificationInput,
  ): Promise<PushDispatchResult> {
    const prefs = await this.loadPreferences(userId);

    if (isCategoryEnabled(prefs, input.category, 'in_app')) {
      try {
        await this.createInAppNotification(userId, input);
      } catch (err) {
        this.logger.warn(
          `in-app notification write failed user=${userId} category=${input.category}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (!isCategoryEnabled(prefs, input.category, 'push')) {
      return zeroResult('preference-off');
    }

    if (
      !CRITICAL_NOTIFICATION_CATEGORIES.has(input.category) &&
      isInQuietHours(prefs, new Date())
    ) {
      return zeroResult('quiet-hours');
    }

    const tokens = await this.tokenRepo.find({
      where: { user_id: userId, deleted_at: IsNull() },
    });

    if (tokens.length === 0) {
      return zeroResult('no-tokens');
    }

    const targets: PushTarget[] = tokens.map((t) => ({
      platform: t.platform,
      token: t.token,
    }));
    const payload: PushPayload = {
      title: input.title,
      body: input.body,
      data: input.data,
      category: input.category,
    };

    const primary = this.provider ?? this.fallback;
    const result = await primary.send(targets, payload);

    let pruned = 0;
    if (result.invalidTokens.length > 0) {
      pruned = await this.softDeleteTokens(userId, result.invalidTokens);
    }

    this.logger.log(
      `push category=${input.category} user=${userId} ` +
        `provider=${result.providerName} delivered=${result.delivered}/${targets.length} ` +
        `pruned=${pruned}`,
    );

    return {
      delivered: result.delivered,
      pruned,
      suppressed: false,
    };
  }

  /**
   * Convenience for callers that need to push the same payload to
   * multiple users (a hazard alert ahead on a saved commute fans out
   * to every rider with that commute). Each per-user dispatch goes
   * through the full preference + quiet-hours gate independently.
   *
   * Uses `Promise.allSettled` rather than `Promise.all` so one user's
   * preference-load failure (transient DB blip, missing row in some
   * unforeseen edge case) doesn't abort the whole fanout. Failures
   * are logged at warn level; the aggregate result reflects only the
   * users we managed to reach.
   */
  async sendToUsers(
    userIds: string[],
    input: PushNotificationInput,
  ): Promise<{ delivered: number; pruned: number; users: number }> {
    if (userIds.length === 0) {
      return { delivered: 0, pruned: 0, users: 0 };
    }
    const settled = await Promise.allSettled(
      userIds.map((id) => this.sendToUser(id, input)),
    );
    let delivered = 0;
    let pruned = 0;
    settled.forEach((entry, i) => {
      if (entry.status === 'fulfilled') {
        delivered += entry.value.delivered;
        pruned += entry.value.pruned;
        return;
      }
      const reason =
        entry.reason instanceof Error
          ? entry.reason.message
          : String(entry.reason);
      this.logger.warn(
        `push fanout failed for user=${userIds[i]} category=${input.category}: ${reason}`,
      );
    });
    return { delivered, pruned, users: userIds.length };
  }

  async loadPreferences(userId: string): Promise<NotificationPreferences> {
    const row = await this.prefsRepo.findOne({ where: { user_id: userId } });
    return mergeWithDefaults(row);
  }

  private async softDeleteTokens(
    userId: string,
    tokens: string[],
  ): Promise<number> {
    if (tokens.length === 0) return 0;
    const now = new Date();
    const result = await this.tokenRepo.update(
      { user_id: userId, token: In(tokens), deleted_at: IsNull() },
      { deleted_at: now },
    );
    return result.affected ?? 0;
  }

  private async createInAppNotification(
    userId: string,
    input: PushNotificationInput,
  ): Promise<void> {
    await this.notificationRepo.save(
      this.notificationRepo.create({
        user_id: userId,
        category: input.category,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
      }),
    );
  }
}

export function mergeWithDefaults(
  row: NotificationPreferencesRow | null,
): NotificationPreferences {
  if (!row) {
    return cloneDefaults();
  }
  const merged = cloneDefaults();
  merged.email_digest = row.email_digest;
  merged.marketing_emails = row.marketing_emails;
  merged.quiet_hours_start = row.quiet_hours_start;
  merged.quiet_hours_end = row.quiet_hours_end;
  merged.quiet_hours_timezone = row.quiet_hours_timezone || 'UTC';
  for (const cat of Object.keys(merged.categories) as NotificationCategory[]) {
    const override = row.categories?.[cat];
    if (override) {
      // Symmetric coercion across all three channels — earlier we
      // used `!!email && !!push` alongside `in_app !== false`,
      // which let `in_app: 0` round-trip as `true` while `push: 0`
      // collapsed to `false`. JSONB rows can hold non-boolean
      // values from older writes or hand-edited rows, so coerce
      // each field the same way and fall back to the default when
      // the column is missing.
      const fallback = merged.categories[cat];
      merged.categories[cat] = {
        email:
          override.email !== undefined
            ? Boolean(override.email)
            : fallback.email,
        push:
          override.push !== undefined ? Boolean(override.push) : fallback.push,
        in_app:
          override.in_app !== undefined
            ? Boolean(override.in_app)
            : fallback.in_app,
      };
    }
  }
  return merged;
}

function cloneDefaults(): NotificationPreferences {
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    categories: Object.fromEntries(
      Object.entries(DEFAULT_NOTIFICATION_PREFERENCES.categories).map(
        ([k, v]) => [k, { ...v }],
      ),
    ) as NotificationPreferences['categories'],
  };
}

function isCategoryEnabled(
  prefs: NotificationPreferences,
  category: NotificationCategory,
  channel: keyof NotificationChannelToggles,
): boolean {
  return prefs.categories[category]?.[channel] ?? false;
}

/**
 * Quiet hours are stored as minutes-from-local-midnight in the user's
 * IANA timezone. The window may wrap midnight (e.g. start=1320 / 22:00,
 * end=360 / 06:00 means the suppressed window is 22:00 → 06:00 the
 * following day). When `start === end`, quiet hours are disabled.
 *
 * Critical categories bypass this check entirely — see
 * `CRITICAL_NOTIFICATION_CATEGORIES` in `@tarmoto/shared`.
 */
export function isInQuietHours(
  prefs: NotificationPreferences,
  now: Date,
): boolean {
  const { quiet_hours_start: start, quiet_hours_end: end } = prefs;
  if (start === end) return false;

  const localMinutes = minutesInTimezone(now, prefs.quiet_hours_timezone);
  if (localMinutes == null) {
    // Invalid timezone string — fall through to UTC. Better to apply
    // quiet hours imperfectly than to silently leak past the user's
    // configured DND window.
    return inWindow(start, end, utcMinutes(now));
  }
  return inWindow(start, end, localMinutes);
}

function inWindow(start: number, end: number, minute: number): boolean {
  if (start < end) {
    return minute >= start && minute < end;
  }
  // Wraps midnight: e.g. 22:00 → 06:00 means anything ≥ 22:00 OR < 06:00.
  return minute >= start || minute < end;
}

function utcMinutes(now: Date): number {
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function minutesInTimezone(now: Date, timezone: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    // Some locales render midnight as "24" — clamp.
    return ((hour % 24) * 60 + minute) % 1440;
  } catch {
    return null;
  }
}

function zeroResult(
  reason: PushDispatchResult['suppressedReason'],
): PushDispatchResult {
  return {
    delivered: 0,
    pruned: 0,
    suppressed: true,
    suppressedReason: reason,
  };
}
