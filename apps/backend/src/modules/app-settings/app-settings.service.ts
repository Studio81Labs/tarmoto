import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LAUNCH_GRANT_TIERS, type LaunchGrantTier } from '@tarmoto/shared';
import { AppSetting } from '../../entities/app-setting.entity.js';

/** `app_settings` key backing the launch-mode registration grant. */
export const LAUNCH_TIER_KEY = 'launch_tier';

export interface LaunchTierSetting {
  /** Tier auto-granted to new registrations, or null when launch mode is off. */
  tier: LaunchGrantTier | null;
  updated_by: string | null;
  updated_at: string | null;
}

/**
 * Operator key/value settings (sibling nexcue/tabletap `launch_all_pro`
 * pattern, generalised to a tier picker because tarmoto has two paid
 * tiers). While a launch tier is set, every new registration is created
 * on that tier with `plan_source = 'founder'`; existing users are never
 * touched. No row (or a stale/invalid value) means launch mode is off.
 */
@Injectable()
export class AppSettingsService {
  constructor(
    @InjectRepository(AppSetting)
    private readonly settings: Repository<AppSetting>,
  ) {}

  async getLaunchTier(): Promise<LaunchTierSetting> {
    const row = await this.settings.findOne({
      where: { key: LAUNCH_TIER_KEY },
    });
    const valid =
      row !== null &&
      (LAUNCH_GRANT_TIERS as readonly string[]).includes(row.value);
    return {
      tier: valid ? (row.value as LaunchGrantTier) : null,
      updated_by: valid ? row.updated_by : null,
      updated_at: valid ? row.updated_at.toISOString() : null,
    };
  }

  /** Set the auto-grant tier, or pass null to turn launch mode off. */
  async setLaunchTier(
    tier: LaunchGrantTier | null,
    adminUserId: string,
  ): Promise<LaunchTierSetting> {
    if (tier === null) {
      await this.settings.delete({ key: LAUNCH_TIER_KEY });
      return { tier: null, updated_by: null, updated_at: null };
    }
    const existing = await this.settings.findOne({
      where: { key: LAUNCH_TIER_KEY },
    });
    const row = existing ?? this.settings.create({ key: LAUNCH_TIER_KEY });
    row.value = tier;
    row.updated_by = adminUserId;
    await this.settings.save(row);
    return this.getLaunchTier();
  }
}
