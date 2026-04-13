import { ApiProperty } from '@nestjs/swagger';

class UserResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  display_name: string;

  @ApiProperty({ required: false, nullable: true })
  phone: string | null;

  @ApiProperty()
  created_at: string;
}

export class AuthResponseDto {
  @ApiProperty()
  access_token: string;

  @ApiProperty()
  refresh_token: string;

  @ApiProperty({ description: 'Seconds until access token expires' })
  expires_in: number;

  @ApiProperty({ type: UserResponse })
  user: UserResponse;
}
