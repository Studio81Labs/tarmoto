import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({
    description:
      'The single-use token delivered via the verification email link.',
  })
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;
}
