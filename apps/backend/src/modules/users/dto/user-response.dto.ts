import { ApiProperty } from '@nestjs/swagger';
import {
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@tarmoto/shared';
import { FeatureSnapshotDto } from '../../features/dto/feature-snapshot.dto.js';
import { LimitSnapshotDto } from '../../features/dto/limit-snapshot.dto.js';

class LatLngResponse {
  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;
}

/**
 * Subset of `users.preferences` JSONB the mobile and companion clients
 * read directly. All fields are optional because the JSONB column starts
 * empty and is populated lazily as the rider toggles things in Settings —
 * a freshly-registered user reaches the client without any prefs set, so
 * consumers must handle missing fields with their own defaults rather
 * than assume the server will fill them in.
 */
/** Mirror of `UserRoutePrefsDto` — the rider's saved planner defaults. */
class UserRoutePrefsResponse {
  @ApiProperty({
    enum: [
      'direct',
      'balanced',
      'scenic_balance',
      'maximum_twisty',
      'efficient_loop',
    ],
  })
  road_preference!:
    | 'direct'
    | 'balanced'
    | 'scenic_balance'
    | 'maximum_twisty'
    | 'efficient_loop';

  @ApiProperty()
  avoid_highways!: boolean;

  @ApiProperty()
  avoid_tolls!: boolean;

  @ApiProperty()
  avoid_unpaved!: boolean;

  @ApiProperty({ type: [String] })
  surfaces!: string[];

  @ApiProperty({
    enum: ['any', 'fair_or_better', 'good_or_better', 'excellent_only'],
  })
  min_quality!: 'any' | 'fair_or_better' | 'good_or_better' | 'excellent_only';
}

class UserPreferencesResponse {
  @ApiProperty({ required: false, enum: ['metric', 'imperial'] })
  units?: 'metric' | 'imperial';

  @ApiProperty({
    required: false,
    description:
      'BCP-47 regional-format locale (e.g. cs-CZ) driving number/date ' +
      "display. Auto-captured from the rider's browser; user-editable later.",
  })
  format_locale?: string;

  @ApiProperty({
    required: false,
    description:
      'IANA display timezone (e.g. Europe/Prague). Auto-synced to mirror ' +
      "the rider's current device (companion FormatPrefsSync).",
  })
  timezone?: string;

  @ApiProperty({ required: false })
  daily_km?: number;

  @ApiProperty({ required: false })
  min_quality?: number;

  @ApiProperty({ required: false, type: [String] })
  road_types?: string[];

  @ApiProperty({ required: false })
  record_gps?: boolean;

  @ApiProperty({ required: false })
  crash_detection?: boolean;

  @ApiProperty({ required: false, type: UserRoutePrefsResponse })
  route_prefs?: UserRoutePrefsResponse;
}

export class UserResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({ nullable: true })
  phone!: string | null;

  @ApiProperty({ nullable: true })
  avatar_url!: string | null;

  @ApiProperty({ nullable: true })
  bio!: string | null;

  @ApiProperty({ enum: SUPPORTED_LOCALES })
  language!: SupportedLocale;

  @ApiProperty({ nullable: true })
  home_region!: string | null;

  @ApiProperty({ nullable: true, type: LatLngResponse })
  home_location!: LatLngResponse | null;

  @ApiProperty({ nullable: true, type: LatLngResponse })
  work_location!: LatLngResponse | null;

  @ApiProperty({ type: UserPreferencesResponse })
  preferences!: UserPreferencesResponse;

  @ApiProperty({
    enum: SUBSCRIPTION_TIERS,
    description: "The rider's subscription tier (drives feature grants).",
  })
  subscription_tier!: SubscriptionTier;

  @ApiProperty({
    type: FeatureSnapshotDto,
    description:
      'Resolved feature entitlements (tier + overrides). UI gating only — ' +
      'gated endpoints re-check server-side.',
  })
  features!: FeatureSnapshotDto;

  @ApiProperty({
    type: LimitSnapshotDto,
    description:
      'Resolved numeric entitlements (null = unlimited), keyed by limit registry key.',
  })
  limits!: LimitSnapshotDto;

  @ApiProperty()
  created_at!: string;
}

export class ContactResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  phone!: string;

  @ApiProperty()
  is_emergency!: boolean;

  @ApiProperty()
  created_at!: string;
}
