import { ApiProperty } from '@nestjs/swagger';

class LatLngResponse {
  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;
}

export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  display_name: string;

  @ApiProperty({ nullable: true })
  phone: string | null;

  @ApiProperty({ nullable: true, type: LatLngResponse })
  home_location: LatLngResponse | null;

  @ApiProperty({ nullable: true, type: LatLngResponse })
  work_location: LatLngResponse | null;

  @ApiProperty()
  preferences: Record<string, unknown>;

  @ApiProperty()
  created_at: string;
}

export class ContactResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  is_emergency: boolean;

  @ApiProperty()
  created_at: string;
}
