import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class ListMessagesDto {
  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 100,
    default: 50,
    description: 'Max number of messages to return (newest first).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({
    required: false,
    description:
      'Keyset cursor — return messages strictly older than this ISO-8601 timestamp. ' +
      'Use the oldest `created_at` in the previous page to fetch the next.',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;
}
