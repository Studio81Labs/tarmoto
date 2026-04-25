import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { CrashAlertSeverity } from '../../../entities/crash-alert.entity.js';

export const CRASH_ALERT_SEVERITIES = ['low', 'medium', 'high'] as const;

export class CrashAlertDto {
  @ApiProperty({ example: 49.1 })
  @IsNumber()
  lat!: number;

  @ApiProperty({ example: 16.75 })
  @IsNumber()
  lng!: number;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ride_id?: string;

  @ApiProperty({ required: false, description: 'Last known speed in km/h' })
  @IsOptional()
  @IsNumber()
  speed_at_impact?: number;

  @ApiProperty({
    required: false,
    enum: CRASH_ALERT_SEVERITIES,
    description:
      'Severity drives channel selection. `high` triggers a voice call ' +
      'in addition to SMS when the notifier supports it.',
  })
  @IsOptional()
  @IsEnum(CRASH_ALERT_SEVERITIES)
  severity?: CrashAlertSeverity;

  @ApiProperty({
    required: false,
    description:
      'Client-supplied idempotency key. Re-using the same UUID with a ' +
      'subsequent request returns the original outcome instead of ' +
      're-dispatching the SMS/voice messages.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  alert_id?: string;

  @ApiProperty({
    required: false,
    description:
      'Override the rider locale for the dispatched message. Defaults ' +
      'to the value stored on `users.preferences.locale`, falling back ' +
      'to English.',
    example: 'cs-CZ',
  })
  @IsOptional()
  @IsString()
  locale?: string;
}

export class CrashAlertContactStatusDto {
  @ApiProperty({ format: 'uuid' })
  contact_id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['sms', 'voice', 'log'] })
  channel!: 'sms' | 'voice' | 'log';

  @ApiProperty({ enum: ['sent', 'failed', 'skipped'] })
  status!: 'sent' | 'failed' | 'skipped';

  @ApiProperty({ required: false, nullable: true })
  provider_message_id!: string | null;

  @ApiProperty({ required: false, nullable: true })
  error!: string | null;
}

export class CrashAlertResponseDto {
  @ApiProperty({
    description: 'Number of contacts that received at least one channel.',
  })
  contacts_notified!: number;

  @ApiProperty()
  alert_id!: string;

  @ApiProperty({ type: [CrashAlertContactStatusDto] })
  contacts!: CrashAlertContactStatusDto[];

  @ApiProperty({
    description:
      'True when this is a duplicate of a previously dispatched alert ' +
      'and no new messages were sent.',
  })
  idempotent_replay!: boolean;
}
