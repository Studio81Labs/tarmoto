import { ApiProperty } from '@nestjs/swagger';

export class MessageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  trip_id!: string;

  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  author_display_name!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty()
  created_at!: string;
}
