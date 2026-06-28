import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminRoles } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { setAdminAuditTarget } from '../admin/admin-audit-context.js';
import { AdminFlagsService } from './admin-flags.service.js';
import {
  CreateFeatureFlagDto,
  FeatureFlagDto,
  UpdateFeatureFlagDto,
} from './dto/admin-flags.dto.js';

@ApiTags('admin')
@Controller('admin')
export class AdminFlagsController {
  constructor(private readonly service: AdminFlagsService) {}

  @Get('flags')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'List feature flags' })
  @ApiResponse({ status: 200, type: [FeatureFlagDto] })
  list(): Promise<FeatureFlagDto[]> {
    return this.service.list();
  }

  @Post('flags')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'Create a feature flag' })
  @ApiResponse({ status: 201, type: FeatureFlagDto })
  async create(
    @Req() req: AdminRequest,
    @Body() dto: CreateFeatureFlagDto,
  ): Promise<FeatureFlagDto> {
    const flag = await this.service.create(dto);
    setAdminAuditTarget(req, {
      target_type: 'feature_flag',
      target_id: flag.id,
    });
    return flag;
  }

  @Patch('flags/:id')
  @AdminRoles('admin')
  @ApiOperation({ summary: 'Update a feature flag (enabled / description)' })
  @ApiResponse({ status: 200, type: FeatureFlagDto })
  async update(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeatureFlagDto,
  ): Promise<FeatureFlagDto> {
    setAdminAuditTarget(req, { target_type: 'feature_flag', target_id: id });
    return this.service.update(id, dto);
  }

  @Delete('flags/:id')
  @AdminRoles('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a feature flag' })
  async remove(
    @Req() req: AdminRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    setAdminAuditTarget(req, { target_type: 'feature_flag', target_id: id });
    return this.service.remove(id);
  }
}
