import { IsIn, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const TRIP_STATUSES = ['draft', 'planned', 'active', 'completed'] as const;

export class ListTripsDto {
  @ApiProperty({ required: false, enum: TRIP_STATUSES })
  @IsOptional()
  @IsIn(TRIP_STATUSES)
  status?: (typeof TRIP_STATUSES)[number];
}
