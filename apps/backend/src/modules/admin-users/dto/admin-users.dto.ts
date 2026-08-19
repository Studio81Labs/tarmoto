import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const ADMIN_USER_DELETED_FILTERS = ['active', 'deleted', 'all'] as const;
export type AdminUserDeletedFilter =
  (typeof ADMIN_USER_DELETED_FILTERS)[number];

export class ListAdminUsersQueryDto {
  @ApiPropertyOptional({
    description: 'Substring match on email or display_name.',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    enum: ADMIN_USER_DELETED_FILTERS,
    default: 'active',
    description: 'Filter by soft-deleted state.',
  })
  @IsOptional()
  @IsIn(ADMIN_USER_DELETED_FILTERS)
  deleted?: AdminUserDeletedFilter;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({
    description:
      'Filter by subscription_tier OR subscription_status value. ' +
      'Valid examples: free | premium | pro | active | trialing | past_due | canceled.',
  })
  @IsOptional()
  @IsString()
  subscription?: string;
}

export class AdminUserRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() display_name!: string;
  @ApiProperty() subscription_tier!: string;
  @ApiProperty() subscription_status!: string;
  @ApiProperty() created_at!: string;
  @ApiProperty({ nullable: true }) deleted_at!: string | null;
}

export class AdminUserListResponseDto {
  @ApiProperty({ type: [AdminUserRowDto] }) rows!: AdminUserRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class AdminUserActivityDto {
  @ApiProperty() rides!: number;
  @ApiProperty() hazardReports!: number;
  @ApiProperty() roadReviews!: number;
  @ApiProperty() trips!: number;
  @ApiProperty() commuteRoutes!: number;
}

export class AdminUserDetailDto extends AdminUserRowDto {
  @ApiProperty({ nullable: true }) home_region!: string | null;
  @ApiProperty({
    nullable: true,
    description:
      'Tier provenance: subscription | founder (launch-mode grant) | ' +
      'promo | admin. Null on rows predating provenance tracking.',
  })
  plan_source!: string | null;
  @ApiProperty({ nullable: true }) email_verified_at!: string | null;
  @ApiProperty({ nullable: true }) subscription_current_period_end!:
    string | null;
  @ApiProperty() subscription_cancel_at_period_end!: boolean;
  @ApiProperty({ nullable: true }) deletion_scheduled_at!: string | null;
  @ApiProperty({ nullable: true }) deletion_reason!: string | null;
  @ApiProperty({ type: AdminUserActivityDto }) activity!: AdminUserActivityDto;
}
