import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import { AdminEmailService } from './admin-email.service.js';
import {
  AdminEmailLogListResponseDto,
  ListAdminEmailLogQueryDto,
} from './dto/admin-email.dto.js';

@ApiTags('admin')
@Controller('admin')
export class AdminEmailController {
  constructor(private readonly service: AdminEmailService) {}

  @Get('email/log')
  @AdminRoles('support')
  @ApiOperation({
    summary: 'List the outbound email delivery log (paginated, filterable)',
  })
  @ApiResponse({ status: 200, type: AdminEmailLogListResponseDto })
  list(
    @Query() query: ListAdminEmailLogQueryDto,
  ): Promise<AdminEmailLogListResponseDto> {
    return this.service.list(query);
  }
}
