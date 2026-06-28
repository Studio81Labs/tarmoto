import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { VALID_ROLES } from '../../../scripts/create-admin-args.js';
import type { AdminRole } from '../../../entities/admin-user.entity.js';

export class AdminRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: VALID_ROLES }) role!: AdminRole;
  @ApiProperty({ enum: ['active', 'disabled'] }) status!: 'active' | 'disabled';
  @ApiProperty({ nullable: true }) last_login_at!: string | null;
  @ApiProperty() created_at!: string;
}

export class CreateAdminDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: VALID_ROLES }) @IsIn(VALID_ROLES) role!: AdminRole;
  @ApiProperty({ enum: ['password', 'sso-only'] })
  @IsIn(['password', 'sso-only'])
  mode!: 'password' | 'sso-only';
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export class PatchAdminDto {
  @ApiPropertyOptional({ enum: VALID_ROLES })
  @IsOptional()
  @IsIn(VALID_ROLES)
  role?: AdminRole;

  @ApiPropertyOptional({ description: 'true = active, false = disabled' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
