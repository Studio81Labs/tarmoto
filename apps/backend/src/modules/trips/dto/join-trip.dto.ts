import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class JoinTripDto {
  @ApiProperty({
    minLength: 4,
    maxLength: 12,
    description:
      'Short uppercase invite code shown to the trip owner. ' +
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
