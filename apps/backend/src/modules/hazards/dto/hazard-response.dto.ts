import { ApiProperty } from '@nestjs/swagger';
import {
  HAZARD_TYPES,
  HAZARD_SEVERITY,
  type HazardType,
  type HazardSeverity,
} from '@tarmoto/shared';

export class HazardResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;

  @ApiProperty({ enum: HAZARD_TYPES })
  hazard_type!: HazardType;

  @ApiProperty({ enum: HAZARD_SEVERITY })
  severity!: HazardSeverity;

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
