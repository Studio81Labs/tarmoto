import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto.js';

export class AuthResponseDto {
  @ApiProperty()
  access_token!: string;

  @ApiProperty()
  refresh_token!: string;

  @ApiProperty({ description: 'Seconds until access token expires' })
  expires_in!: number;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}
