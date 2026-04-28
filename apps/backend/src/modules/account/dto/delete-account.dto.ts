import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Re-authentication payload for `DELETE /account`. The rider has
 * already been authenticated via JWT, but GDPR-grade deletion is
 * irreversible after the grace window — so we require the password
 * one more time as a fresh-auth proof. `reason` is optional metadata
 * captured for the audit log only.
 */
export class DeleteAccountDto {
  @ApiProperty({
    description:
      'Current account password, re-entered to confirm the deletion intent.',
  })
  @IsString()
  @MinLength(1)
  password!: string;

  @ApiProperty({
    required: false,
    description: 'Optional free-text reason (stored on the audit log).',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
