import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { isSupportedLocale, type SupportedLocale } from '@tarmoto/shared';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminEmailTemplateService } from './admin-email-template.service.js';
import {
  EmailTemplateDetailDto,
  EmailTemplateSummaryDto,
  PreviewRequestDto,
  PreviewResponseDto,
  SaveDraftDto,
  TestSendResponseDto,
} from './dto/admin-email-template.dto.js';

@ApiTags('admin')
@Controller('admin/email/templates')
export class AdminEmailTemplateController {
  constructor(private readonly service: AdminEmailTemplateService) {}

  @Get()
  @AdminRoles('support')
  @ApiOperation({
    summary: 'List editable email templates with draft/published status',
  })
  @ApiResponse({ status: 200, type: [EmailTemplateSummaryDto] })
  list(): Promise<EmailTemplateSummaryDto[]> {
    return this.service.list();
  }

  @Get(':tag/:locale')
  @AdminRoles('support')
  @ApiOperation({
    summary:
      'Get the editable document (draft, else published, else empty) for a template',
  })
  @ApiResponse({ status: 200, type: EmailTemplateDetailDto })
  get(
    @Param('tag') tag: string,
    @Param('locale') locale: string,
  ): Promise<EmailTemplateDetailDto> {
    return this.service.get(tag, this.locale(locale));
  }

  @Put(':tag/:locale/draft')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Save (upsert) the draft override for a template' })
  @ApiResponse({ status: 200, type: EmailTemplateDetailDto })
  saveDraft(
    @Req() req: AdminRequest,
    @Param('tag') tag: string,
    @Param('locale') locale: string,
    @Body() dto: SaveDraftDto,
  ): Promise<EmailTemplateDetailDto> {
    const loc = this.locale(locale);
    setAdminAuditTarget(req, {
      target_type: 'email',
      target_id: `${tag}/${loc}`,
    });
    return this.service.saveDraft(tag, loc, dto, req.adminUser?.id ?? null);
  }

  @Post(':tag/:locale/preview')
  @AdminRoles('support')
  @ApiOperation({
    summary: 'Render a preview of the supplied document with sample data',
  })
  @ApiResponse({ status: 201, type: PreviewResponseDto })
  preview(
    @Param('tag') tag: string,
    @Param('locale') locale: string,
    @Body() dto: PreviewRequestDto,
  ): Promise<PreviewResponseDto> {
    return this.service.preview(tag, this.locale(locale), dto);
  }

  @Post(':tag/:locale/test-send')
  @AdminRoles('support')
  @ApiOperation({
    summary: 'Send a rendered preview to your own admin address',
  })
  @ApiResponse({ status: 201, type: TestSendResponseDto })
  testSend(
    @Req() req: AdminRequest,
    @Param('tag') tag: string,
    @Param('locale') locale: string,
    @Body() dto: PreviewRequestDto,
  ): Promise<TestSendResponseDto> {
    const email = req.adminUser?.email;
    if (!email) {
      throw new BadRequestException('Authenticated admin has no email address');
    }
    const loc = this.locale(locale);
    setAdminAuditTarget(req, {
      target_type: 'email',
      target_id: `${tag}/${loc}`,
    });
    return this.service.testSend(tag, loc, dto, email);
  }

  @Post(':tag/:locale/publish')
  @AdminRoles('super_admin')
  @ApiOperation({
    summary: 'Publish the draft as the live override (super admin only)',
  })
  @ApiResponse({ status: 201, type: EmailTemplateDetailDto })
  publish(
    @Req() req: AdminRequest,
    @Param('tag') tag: string,
    @Param('locale') locale: string,
  ): Promise<EmailTemplateDetailDto> {
    const loc = this.locale(locale);
    setAdminAuditTarget(req, {
      target_type: 'email',
      target_id: `${tag}/${loc}`,
    });
    return this.service.publish(tag, loc, req.adminUser?.id ?? null);
  }

  @Delete(':tag/:locale/override')
  @AdminRoles('super_admin')
  @ApiOperation({
    summary:
      'Remove the published override so the code template renders again (super admin only)',
  })
  @ApiResponse({ status: 200 })
  reset(
    @Req() req: AdminRequest,
    @Param('tag') tag: string,
    @Param('locale') locale: string,
  ): Promise<void> {
    const loc = this.locale(locale);
    setAdminAuditTarget(req, {
      target_type: 'email',
      target_id: `${tag}/${loc}`,
    });
    return this.service.reset(tag, loc);
  }

  private locale(locale: string): SupportedLocale {
    if (!isSupportedLocale(locale)) {
      throw new BadRequestException(`Unsupported locale: ${locale}`);
    }
    return locale;
  }
}
