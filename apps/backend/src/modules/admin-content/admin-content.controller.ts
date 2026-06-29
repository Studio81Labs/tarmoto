import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminContentService } from './admin-content.service.js';
import { CONTENT_TYPES, ContentType } from './content-types.js';
import {
  ContentItemDto,
  ContentListResponseDto,
  HideContentDto,
  ListContentQueryDto,
} from './dto/admin-content.dto.js';

@ApiTags('admin')
@Controller('admin')
export class AdminContentController {
  constructor(private readonly service: AdminContentService) {}

  @Get('content')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Browse user-generated content for moderation' })
  @ApiResponse({ status: 200, type: ContentListResponseDto })
  list(@Query() query: ListContentQueryDto): Promise<ContentListResponseDto> {
    return this.service.list(query);
  }

  @Post('content/:type/:id/hide')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Hide a content item from public surfaces' })
  @ApiResponse({ status: 201, type: ContentItemDto })
  async hide(
    @Req() req: AdminRequest,
    @Param('type', new ParseEnumPipe(ContentType)) type: ContentType,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HideContentDto,
  ): Promise<ContentItemDto> {
    setAdminAuditTarget(req, {
      target_type: CONTENT_TYPES[type].auditTargetType,
      target_id: id,
    });
    return this.service.hide(type, id, req.adminUser!.id, dto.reason ?? null);
  }

  @Post('content/:type/:id/restore')
  @AdminRoles('support')
  @ApiOperation({ summary: 'Restore a previously hidden content item' })
  @ApiResponse({ status: 201, type: ContentItemDto })
  async restore(
    @Req() req: AdminRequest,
    @Param('type', new ParseEnumPipe(ContentType)) type: ContentType,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContentItemDto> {
    setAdminAuditTarget(req, {
      target_type: CONTENT_TYPES[type].auditTargetType,
      target_id: id,
    });
    return this.service.restore(type, id);
  }

  @Delete('content/:type/:id')
  @AdminRoles('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Permanently delete a content item' })
  async remove(
    @Req() req: AdminRequest,
    @Param('type', new ParseEnumPipe(ContentType)) type: ContentType,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    setAdminAuditTarget(req, {
      target_type: CONTENT_TYPES[type].auditTargetType,
      target_id: id,
    });
    return this.service.remove(type, id);
  }
}
