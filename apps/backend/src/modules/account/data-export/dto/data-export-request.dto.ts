import { ApiProperty } from '@nestjs/swagger';

export class DataExportRequestDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: ['queued', 'processing', 'ready', 'failed', 'expired'],
  })
  status!: 'queued' | 'processing' | 'ready' | 'failed' | 'expired';

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Signed download URL valid until expiresAt. Present only when status is "ready".',
  })
  downloadUrl!: string | null;

  @ApiProperty({ nullable: true })
  byteSize!: number | null;

  @ApiProperty({ nullable: true })
  errorMessage!: string | null;
}
