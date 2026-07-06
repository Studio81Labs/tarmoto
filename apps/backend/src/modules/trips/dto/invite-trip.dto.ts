import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ASSIGNABLE_TRIP_ROLES,
  type AssignableTripRole,
} from './collaborators.dto.js';

export class InviteTripDto {
  @ApiProperty({
    description:
      'Recipient email address. The recipient does NOT need a Tarmoto ' +
      'account yet — the invite mail explains how to sign up and join.',
    maxLength: 255,
    example: 'rider@example.com',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    required: false,
    description:
      'Optional personal note from the inviter, rendered into the email ' +
      'body verbatim (HTML-escaped). Capped at 500 chars to keep the ' +
      'mail readable on small screens.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @ApiProperty({
    required: false,
    enum: ASSIGNABLE_TRIP_ROLES,
    description:
      'Role the invitee receives when they accept. Defaults to `editor` ' +
      '(they are being invited by name, unlike anonymous link-joiners ' +
      'who start as `viewer`).',
  })
  @IsOptional()
  @IsIn(ASSIGNABLE_TRIP_ROLES)
  role?: AssignableTripRole;
}

export class InviteTripResponseDto {
  @ApiProperty({
    description:
      'Always `queued`. The invite email is dispatched best-effort — a ' +
      'delivery failure is logged on the backend but does NOT fail the ' +
      'API call, so the response is the same whether the provider ' +
      'accepted the message or not.',
  })
  status!: 'queued';
}
