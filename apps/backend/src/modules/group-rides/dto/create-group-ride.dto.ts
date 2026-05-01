import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateGroupRideDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    description:
      'Display name shown in the group-ride pickers (e.g. "Sunday Dolomites").',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
