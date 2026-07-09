import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminEmailService } from './admin-email.service.js';
import {
  AdminEmailLogListResponseDto,
  ListAdminEmailLogQueryDto,
  ResendDigestDto,
  ResendDigestResponseDto,
  TestDigestResponseDto,
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

  @Post('email/digest-test')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Send a sample weekly digest to your own address' })
  @ApiResponse({ status: 201, type: TestDigestResponseDto })
  sendTestDigest(@Req() req: AdminRequest): Promise<TestDigestResponseDto> {
    const email = req.adminUser?.email;
    if (!email) {
      // Should never happen — the guard populates adminUser — but never send a
      // preview into the void.
      throw new BadRequestException('Authenticated admin has no email address');
    }
    setAdminAuditTarget(req, { target_type: 'email', target_id: email });
    return this.service.sendTestDigest(email);
  }

  @Post('email/digest-resend')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Re-trigger a rider’s weekly digest by recipient' })
  @ApiResponse({ status: 201, type: ResendDigestResponseDto })
  resendDigest(
    @Req() req: AdminRequest,
    @Body() dto: ResendDigestDto,
  ): Promise<ResendDigestResponseDto> {
    setAdminAuditTarget(req, {
      target_type: 'email',
      target_id: dto.recipient,
    });
    return this.service.resendDigest(dto.recipient);
  }
}
