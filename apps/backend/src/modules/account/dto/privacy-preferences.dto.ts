import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  LOCATION_RETENTION_VALUES,
  PROFILE_VISIBILITY_VALUES,
  RIDE_SHARING_VALUES,
  type LocationRetention,
  type PrivacyPreferences,
  type ProfileVisibility,
  type RideSharingDefault,
} from '@tarmoto/shared';

/**
 * Partial-update body for `PUT /account/privacy`. Every field is
 * optional so the companion can send a single toggle change without
 * round-tripping the full object — supplied fields update in place,
 * omitted ones keep their current value.
 */
export class UpdatePrivacyPreferencesDto {
  @ApiProperty({ enum: PROFILE_VISIBILITY_VALUES, required: false })
  @IsOptional()
  @IsIn(PROFILE_VISIBILITY_VALUES)
  profile_visibility?: ProfileVisibility;

  @ApiProperty({ enum: RIDE_SHARING_VALUES, required: false })
  @IsOptional()
  @IsIn(RIDE_SHARING_VALUES)
  default_ride_sharing?: RideSharingDefault;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  road_data_contribution?: boolean;

  @ApiProperty({ enum: LOCATION_RETENTION_VALUES, required: false })
  @IsOptional()
  @IsIn(LOCATION_RETENTION_VALUES)
  location_retention?: LocationRetention;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  analytics_consent?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  personalized_recommendations_consent?: boolean;
}

export class PrivacyPreferencesResponseDto implements PrivacyPreferences {
  @ApiProperty({ enum: PROFILE_VISIBILITY_VALUES })
  profile_visibility!: ProfileVisibility;

  @ApiProperty({ enum: RIDE_SHARING_VALUES })
  default_ride_sharing!: RideSharingDefault;

  @ApiProperty()
  road_data_contribution!: boolean;

  @ApiProperty({ enum: LOCATION_RETENTION_VALUES })
  location_retention!: LocationRetention;

  @ApiProperty()
  analytics_consent!: boolean;

  @ApiProperty()
  personalized_recommendations_consent!: boolean;
}
