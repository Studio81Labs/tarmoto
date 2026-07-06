import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class JoinTripDto {
  @ApiProperty({
    minLength: 4,
    maxLength: 12,
    description:
      'Personal invite code from the invite email (each recipient gets ' +
      'their own; revoking an invite invalidates its code). ' +
      'Case-insensitive on input — server normalizes to uppercase.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(4)
  @MaxLength(12)
  invite_code!: string;
}
