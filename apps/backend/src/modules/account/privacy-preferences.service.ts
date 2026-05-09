import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DEFAULT_PRIVACY_PREFERENCES,
  type PrivacyPreferences,
} from '@tarmoto/shared';
import { PrivacyPreferencesRow } from '../../entities/privacy-preferences.entity.js';
import {
  PrivacyPreferencesResponseDto,
  UpdatePrivacyPreferencesDto,
} from './dto/privacy-preferences.dto.js';

/**
 * Reads and writes per-user privacy preferences (#279). Mirrors the
 * notification-preferences pattern: rows are created lazily, reads
 * always fall back to the canonical defaults from `@tarmoto/shared`,
 * writes are partial.
 *
 * Enforcement of each toggle lives at the call site (profile endpoint,
 * ride finish, sensor upload, retention sweeper, analytics gate) — this
 * service only owns the persisted state. Other modules read via the
 * exported helpers (`loadPreferences`, `isAllowedToContributeRoadData`,
 * etc.) so the storage shape can evolve without rewriting every gate.
 */
@Injectable()
export class PrivacyPreferencesService {
  constructor(
    @InjectRepository(PrivacyPreferencesRow)
    private readonly repo: Repository<PrivacyPreferencesRow>,
  ) {}

  async get(userId: string): Promise<PrivacyPreferencesResponseDto> {
    return this.toResponse(await this.loadPreferences(userId));
  }

  async update(
    userId: string,
    dto: UpdatePrivacyPreferencesDto,
  ): Promise<PrivacyPreferencesResponseDto> {
    const existing = await this.repo.findOne({ where: { user_id: userId } });
    const current = mergeWithDefaults(existing);
    const merged = applyPatch(current, dto);

    const row =
      existing ??
      this.repo.create({
        user_id: userId,
      });

    row.profile_visibility = merged.profile_visibility;
    row.default_ride_sharing = merged.default_ride_sharing;
    row.road_data_contribution = merged.road_data_contribution;
    row.location_retention = merged.location_retention;
    row.analytics_consent = merged.analytics_consent;
    row.personalized_recommendations_consent =
      merged.personalized_recommendations_consent;

    const saved = await this.repo.save(row);
    return this.toResponse(mergeWithDefaults(saved));
  }

  /**
   * Public helper for other modules that need to gate behavior on a
   * preference toggle. Always returns the full preferences object —
   * canonical defaults fill in for users with no row.
   */
  async loadPreferences(userId: string): Promise<PrivacyPreferences> {
    const row = await this.repo.findOne({ where: { user_id: userId } });
    return mergeWithDefaults(row);
  }

  /**
   * Resolve which of the supplied user ids belong to riders with
   * `profile_visibility = 'private'` (#279 / #501). Single batched
   * SELECT, used by every consumer that masks display names on a
   * cross-user feed (route reviews, route collections, …) — kept
   * here rather than duplicated per-service so the fail-closed
   * posture and shape stay aligned automatically (Cursor Bugbot
   * review on PR #513).
   *
   * Riders without an explicit `privacy_preferences` row inherit
   * the default (`riders-only`) and are NOT in the returned set.
   *
   * Fail-closed: a transient DB error returns every supplied id so
   * the caller masks the whole feed rather than risking a leak —
   * better to over-mask once than surface a private rider's name on
   * a hiccup.
   */
  async loadPrivateUserIds(userIds: readonly string[]): Promise<Set<string>> {
    const unique = Array.from(new Set(userIds.filter((id) => Boolean(id))));
    if (unique.length === 0) return new Set();
    try {
      const rows = await this.repo.find({
        where: { user_id: In(unique), profile_visibility: 'private' },
        select: { user_id: true },
      });
      return new Set(rows.map((r) => r.user_id));
    } catch {
      return new Set(unique);
    }
  }

  private toResponse(prefs: PrivacyPreferences): PrivacyPreferencesResponseDto {
    return {
      profile_visibility: prefs.profile_visibility,
      default_ride_sharing: prefs.default_ride_sharing,
      road_data_contribution: prefs.road_data_contribution,
      location_retention: prefs.location_retention,
      analytics_consent: prefs.analytics_consent,
      personalized_recommendations_consent:
        prefs.personalized_recommendations_consent,
    };
  }
}

export function mergeWithDefaults(
  row: PrivacyPreferencesRow | null,
): PrivacyPreferences {
  if (!row) return { ...DEFAULT_PRIVACY_PREFERENCES };
  return {
    profile_visibility: row.profile_visibility,
    default_ride_sharing: row.default_ride_sharing,
    road_data_contribution: row.road_data_contribution,
    location_retention: row.location_retention,
    analytics_consent: row.analytics_consent,
    personalized_recommendations_consent:
      row.personalized_recommendations_consent,
  };
}

function applyPatch(
  current: PrivacyPreferences,
  patch: UpdatePrivacyPreferencesDto,
): PrivacyPreferences {
  const next: PrivacyPreferences = { ...current };
  if (patch.profile_visibility !== undefined) {
    next.profile_visibility = patch.profile_visibility;
  }
  if (patch.default_ride_sharing !== undefined) {
    next.default_ride_sharing = patch.default_ride_sharing;
  }
  if (patch.road_data_contribution !== undefined) {
    next.road_data_contribution = Boolean(patch.road_data_contribution);
  }
  if (patch.location_retention !== undefined) {
    next.location_retention = patch.location_retention;
  }
  if (patch.analytics_consent !== undefined) {
    next.analytics_consent = Boolean(patch.analytics_consent);
  }
  if (patch.personalized_recommendations_consent !== undefined) {
    next.personalized_recommendations_consent = Boolean(
      patch.personalized_recommendations_consent,
    );
  }
  return next;
}
