import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { AdminUserView } from '../admin-auth.service.js';

export class AdminLoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;
}

export class AdminUserViewDto implements AdminUserView {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['read_only', 'support', 'admin', 'super_admin'] })
  role!: AdminUserView['role'];
  @ApiProperty({ enum: ['active', 'disabled'] })
  status!: AdminUserView['status'];
}

export class AdminAuthSessionResponseDto {
  @ApiProperty({ type: AdminUserViewDto }) user!: AdminUserViewDto;
  @ApiProperty() expiresIn!: number;
}

export class AdminMeResponseDto {
  @ApiProperty({ type: AdminUserViewDto }) user!: AdminUserViewDto;
}

export class AdminAuthConfigDto {
  @ApiProperty({ description: 'Whether password login is enabled server-side' })
  passwordLoginEnabled!: boolean;
}
