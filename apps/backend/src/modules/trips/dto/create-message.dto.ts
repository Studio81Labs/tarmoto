import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

const MESSAGE_MAX_LENGTH = 2000;

export class CreateMessageDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MESSAGE_MAX_LENGTH,
    description:
      'Message body. Leading/trailing whitespace is trimmed. Empty strings are rejected.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(MESSAGE_MAX_LENGTH)
  body!: string;
}
