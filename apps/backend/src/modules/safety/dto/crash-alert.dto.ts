import { IsNumber, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CrashAlertDto {
  @ApiProperty({ example: 49.1 })
  @IsNumber()
  lat: number;

  @ApiProperty({ example: 16.75 })
  @IsNumber()
  lng: number;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ride_id?: string;

  @ApiProperty({ required: false, description: 'Last known speed in km/h' })
  @IsOptional()
  @IsNumber()
  speed_at_impact?: number;
}

export class CrashAlertResponseDto {
  @ApiProperty()
  contacts_notified: number;

  @ApiProperty()
  alert_id: string;
}
