import {
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsBoolean,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class LatLngDto {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}

class UserPreferencesDto {
  @IsOptional()
  @IsString()
  units?: string;

  @IsOptional()
  @IsNumber()
  daily_km?: number;

  @IsOptional()
  @IsNumber()
  min_quality?: number;

  @IsOptional()
  @IsString({ each: true })
  road_types?: string[];

  @IsOptional()
  @IsBoolean()
  record_gps?: boolean;

  @IsOptional()
  @IsBoolean()
  crash_detection?: boolean;
}

export class UpdateProfileDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiProperty({ required: false, type: LatLngDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LatLngDto)
  home_location?: LatLngDto;

  @ApiProperty({ required: false, type: LatLngDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LatLngDto)
  work_location?: LatLngDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UserPreferencesDto)
  preferences?: UserPreferencesDto;
}
