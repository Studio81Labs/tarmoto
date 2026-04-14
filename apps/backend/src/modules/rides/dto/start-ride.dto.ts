import { IsOptional, IsEnum } from 'class-validator';
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
}
