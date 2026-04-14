import { IsOptional, IsEnum, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const RIDE_TYPES = ['free', 'commute', 'trip', 'tracked'] as const;

export class StartRideDto {
  @ApiProperty({
    enum: RIDE_TYPES,
    default: 'free',
    required: false,
  })
  @IsOptional()
  @IsEnum(RIDE_TYPES)
  ride_type?: (typeof RIDE_TYPES)[number];

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'If riding a planned trip day',
  })
  @IsOptional()
  @IsUUID()
  trip_day_id?: string;
}
