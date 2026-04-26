import { ApiProperty } from '@nestjs/swagger';

/**
 * Response from `DELETE /account`. The user row is soft-deleted
 * immediately; `scheduled_for` is the ISO-8601 timestamp at which the
 * sweeper will perform the permanent purge (default: now + 30 days).
 */
export class DeleteAccountResponseDto {
  @ApiProperty({ example: 'scheduled' })
  status!: 'scheduled';

  @ApiProperty({
    example: '2026-05-26T12:00:00.000Z',
    description:
      'When the hard-delete sweeper will permanently purge the account.',
  })
  scheduled_for!: string;

  @ApiProperty({
    example: 30,
    description: 'Grace period in days before the hard delete runs.',
  })
  grace_period_days!: number;
}
