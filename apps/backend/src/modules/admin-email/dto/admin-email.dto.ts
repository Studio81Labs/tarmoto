import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const EMAIL_LOG_STATUS_FILTERS = ['sent', 'failed'] as const;
export type EmailLogStatusFilter = (typeof EMAIL_LOG_STATUS_FILTERS)[number];

export class ListAdminEmailLogQueryDto {
  @ApiPropertyOptional({
    enum: EMAIL_LOG_STATUS_FILTERS,
    description: 'Filter by delivery status.',
  })
  @IsOptional()
  @IsIn(EMAIL_LOG_STATUS_FILTERS)
  status?: EmailLogStatusFilter;

  @ApiPropertyOptional({
    description: 'Filter by template tag, e.g. "weekly-digest".',
  })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({
    description: 'Exact recipient address (case-insensitive); indexed lookup.',
  })
  @IsOptional()
  @IsString()
  recipient?: string;

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
}

export class AdminEmailLogRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() recipient!: string;
  @ApiProperty() tag!: string;
  @ApiProperty() subject!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true }) provider!: string | null;
  @ApiProperty({ nullable: true }) provider_message_id!: string | null;
  @ApiProperty({ nullable: true }) error_class!: string | null;
  @ApiProperty() created_at!: string;
}

export class AdminEmailLogListResponseDto {
  @ApiProperty({ type: [AdminEmailLogRowDto] }) rows!: AdminEmailLogRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
