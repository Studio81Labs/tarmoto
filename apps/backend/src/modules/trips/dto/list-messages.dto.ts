import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
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
      'Pair with `before_id` (the oldest message id in the previous page) so ' +
      'messages sharing the same `created_at` at a page boundary are not skipped.',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;

  @ApiProperty({
    required: false,
    description:
      'Tie-breaker for the keyset cursor — the id of the oldest message in ' +
      'the previous page. Required together with `before` to correctly page ' +
      'through messages that share a timestamp.',
  })
  // Require `before_id` iff `before` is provided — without the pairing a
  // page boundary with tied timestamps would silently drop messages.
  @ValidateIf((o: ListMessagesDto) => o.before !== undefined)
  @IsUUID()
  before_id?: string;
}
