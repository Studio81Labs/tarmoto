import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DEVICE_PLATFORMS, type DevicePlatform } from '@tarmoto/shared';

export class RegisterDeviceDto {
  @ApiProperty({ enum: DEVICE_PLATFORMS })
  @IsString()
  @IsIn([...DEVICE_PLATFORMS])
  platform!: DevicePlatform;

  @ApiProperty({
    description: 'FCM (Android) or APN (iOS) device token issued by the OS.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;

  @ApiProperty({ required: false, description: 'Optional client app version.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  app_version?: string;
}

export class RegisterDeviceResponseDto {
  @ApiProperty()
  device_id!: string;

  @ApiProperty({ enum: DEVICE_PLATFORMS })
  platform!: DevicePlatform;

  @ApiProperty()
  registered_at!: string;
}

export class UnregisterDeviceDto {
  @ApiProperty({
    description:
      'FCM (Android) or APN (iOS) device token previously registered.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}
