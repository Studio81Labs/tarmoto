import { ApiProperty } from '@nestjs/swagger';

export class HazardResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;

  @ApiProperty()
  hazard_type!: string;

  @ApiProperty()
  severity!: string;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty()
  confirmations!: number;

  @ApiProperty({ nullable: true })
  reporter!: string | null;

  @ApiProperty({ nullable: true })
  road_name!: string | null;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  expires_at!: string;
}
