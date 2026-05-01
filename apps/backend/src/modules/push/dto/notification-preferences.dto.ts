import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  NOTIFICATION_CATEGORIES,
  type EmailDigestFrequency,
  type NotificationCategory,
  type NotificationChannelToggles,
  type NotificationPreferences,
} from '@tarmoto/shared';

export class NotificationChannelTogglesDto implements NotificationChannelToggles {
  @ApiProperty()
  @IsBoolean()
  email!: boolean;

  @ApiProperty()
  @IsBoolean()
  push!: boolean;

  @ApiProperty()
  @IsBoolean()
  in_app!: boolean;
}

export class UpdateNotificationPreferencesDto {
  @ApiProperty({ enum: ['daily', 'weekly', 'never'], required: false })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'never'])
  email_digest?: EmailDigestFrequency;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  marketing_emails?: boolean;

  @ApiProperty({
    required: false,
    description: 'Minutes from local midnight (0–1439). 0 disables.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  quiet_hours_start?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  quiet_hours_end?: number;

  @ApiProperty({
    required: false,
    description: 'IANA timezone (e.g. Europe/Prague). Empty = UTC.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  quiet_hours_timezone?: string;

  @ApiProperty({
    required: false,
    description:
      'Per-category channel toggles. Categories not supplied keep their existing value.',
    additionalProperties: {
      $ref: '#/components/schemas/NotificationChannelTogglesDto',
    },
  })
  @IsOptional()
  @IsObject()
  @ValidateNested({ each: true })
  @Type(() => NotificationChannelTogglesDto)
  categories?: Partial<
    Record<NotificationCategory, NotificationChannelTogglesDto>
  >;
}

export class NotificationPreferencesResponseDto implements NotificationPreferences {
  @ApiProperty({ enum: ['daily', 'weekly', 'never'] })
  email_digest!: EmailDigestFrequency;

  @ApiProperty()
  marketing_emails!: boolean;

  @ApiProperty()
  quiet_hours_start!: number;

  @ApiProperty()
  quiet_hours_end!: number;

  @ApiProperty()
  quiet_hours_timezone!: string;

  @ApiProperty({
    description: 'Per-category toggles for every notification category.',
    additionalProperties: {
      $ref: '#/components/schemas/NotificationChannelTogglesDto',
    },
  })
  categories!: Record<NotificationCategory, NotificationChannelTogglesDto>;
}

export const NOTIFICATION_CATEGORY_VALUES: readonly string[] =
  NOTIFICATION_CATEGORIES;
